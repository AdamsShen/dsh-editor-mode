/**
 * DSH Editor Bridge —— VS Code 扩展（Node 扩展主机）。
 *
 * 三个能力：
 *  1. 侧栏 Chat：activitybar 里的 webview 视图，前端是 media/chat.js，
 *     通过本文件的 Node 侧转发到 DSH 的 /editor-chat/*（流式 SSE），
 *     模型与凭据全部复用 DSH 里已配置的那套（插件不新增任何模型配置）。
 *  2. 选区 → DSH Agents：把当前文件/选区 POST 到 /editor-bridge/push，
 *     由 DSH Client 轮询取走并注入 Agents 输入框。
 *  3. 选区 → 本侧栏 Chat：右键「在 DSH Chat 中询问选中代码」，把上下文填进输入框。
 *
 * 为什么全走 HTTP 而不走 window.postMessage：
 *  扩展跑在 Node 扩展主机（没有 DOM），webview 与 DSH 页面分属不同 origin；
 *  只有「扩展 → DSH 回环 HTTP」这条通道是两端都稳定可达的。
 *
 * 连接参数由 DSH 插件在 spawn code-server 时通过环境注入：
 *   DSH_EDITOR_BASE / DSH_EDITOR_TOKEN   —— Chat 端点
 *   DSH_BRIDGE_URL / DSH_BRIDGE_TOKEN    —— Agents 选区端点
 * 环境缺失时回退读 ~/.dsh/editor-runtime/bridge.json（DSH 重启后仍可用）。
 */

const vscode = require('vscode');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSseBlock, createSseParser } = require('./sse.js');

const VIEW_ID = 'dshEditor.chat';
const STATE_KEY = 'dshEditor.chat.v1';
/** 持久化的对话上限（条）。超出从最旧的丢，避免 globalState 无限膨胀。 */
const HISTORY_MAX = 60;
/** 单条消息发给模型前的长度上限（防止某条超长粘贴撑爆请求）。 */
const MESSAGE_MAX = 20000;

// ---------------------------------------------------------------------------
// 通道解析：env 优先，文件兜底
// ---------------------------------------------------------------------------

/** 读 DSH 插件落盘的 bridge.json；失败返回 null。 */
function readBridgeFile() {
  const candidates = [
    process.env.DSH_EDITOR_BRIDGE_FILE,
    path.join(os.homedir(), '.dsh', 'editor-runtime', 'bridge.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 不存在或半写入，继续找下一个 */ }
  }
  return null;
}

/** 解析出 { base, token, pushUrl }；任一缺失即为未就绪。 */
function channel() {
  const file = readBridgeFile();
  let base = process.env.DSH_EDITOR_BASE || (file && file.base) || '';
  const token = process.env.DSH_EDITOR_TOKEN
    || process.env.DSH_BRIDGE_TOKEN
    || (file && file.token)
    || '';
  // 只有 push URL 时从它推导 origin，避免两套环境变量必须同时存在。
  if (!base && process.env.DSH_BRIDGE_URL) {
    try { base = new URL(process.env.DSH_BRIDGE_URL).origin; } catch { /* 非法 URL */ }
  }
  return {
    base: String(base || '').replace(/\/+$/, ''),
    token: String(token || ''),
    pushUrl: process.env.DSH_BRIDGE_URL || (base ? `${base}/editor-bridge/push` : ''),
  };
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

/** POST 一个 JSON，返回 { status, json }；超时或网络错误抛出。 */
function postJson(pathname, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const { base, token } = channel();
    if (!base || !token) { reject(new Error('DSH 通道未就绪')); return; }
    let target;
    try { target = new URL(pathname, base); } catch (e) { reject(e); return; }
    const payload = Buffer.from(JSON.stringify({ ...body, token }), 'utf8');
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'x-dsh-editor-token': token,
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** GET 一个 JSON（/editor-chat/models）。 */
function getJson(pathname, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const { base, token } = channel();
    if (!base || !token) { reject(new Error('DSH 通道未就绪')); return; }
    let target;
    try {
      target = new URL(pathname, base);
      target.searchParams.set('token', token);
    } catch (e) { reject(e); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'GET',
      headers: { 'x-dsh-editor-token': token },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 发起一次流式对话。onEvent(event, payload) 会被逐条调用。
 * 返回 Promise：流正常结束或出错时 settle（出错 reject）。
 */
function streamChat(body, { onEvent, signal }) {
  return new Promise((resolve, reject) => {
    const { base, token } = channel();
    if (!base || !token) { reject(new Error('DSH 通道未就绪，请从 DSH 重新打开编辑器')); return; }
    let target;
    try { target = new URL('/editor-chat/send', base); } catch (e) { reject(e); return; }
    const payload = Buffer.from(JSON.stringify({ ...body, token }), 'utf8');
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'x-dsh-editor-token': token,
        accept: 'text/event-stream',
      },
      // 长回答可能超过一分钟没有新数据，这里给足空闲窗口。
      timeout: 300000,
      signal,
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, 400);
          reject(new Error(`DSH 返回 ${res.statusCode}${text ? `：${text}` : ''}`));
        });
        return;
      }
      res.setEncoding('utf8');
      const parser = createSseParser(onEvent);
      res.on('data', (chunk) => { parser.push(chunk); });
      res.on('end', () => { parser.flush(); resolve(); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('对话请求超时')));
    req.on('error', (err) => {
      if (err && err.name === 'AbortError') { resolve(); return; }
      reject(err);
    });
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// 编辑器上下文
// ---------------------------------------------------------------------------

/** 收集当前编辑器上下文：相对路径、行号、选区文本、语言、项目目录。 */
function collectContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const doc = editor.document;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const fsPath = doc.uri.scheme === 'file' ? doc.uri.fsPath : '';
  let file = doc.uri.toString();
  if (fsPath) {
    file = folder && fsPath.startsWith(folder)
      ? path.relative(folder, fsPath).split(path.sep).join('/')
      : fsPath;
  }
  const sel = editor.selection;
  const hasSelection = Boolean(sel && !sel.isEmpty);
  const text = hasSelection ? doc.getText(sel).slice(0, MESSAGE_MAX) : '';
  return {
    file,
    line: sel ? sel.start.line + 1 : 1,
    text,
    language: doc.languageId || '',
    folder,
    hasSelection,
    endLine: sel ? sel.end.line + 1 : (sel ? sel.start.line + 1 : 1),
  };
}

/** 上下文的一行摘要，用于侧栏顶部提示。 */
function contextLabel(ctxInfo) {
  if (!ctxInfo) return '未打开文件';
  const loc = `${ctxInfo.file}:${ctxInfo.line}`;
  if (!ctxInfo.hasSelection) return loc;
  const span = ctxInfo.endLine > ctxInfo.line ? `${ctxInfo.line}-${ctxInfo.endLine}` : `${ctxInfo.line}`;
  return `${ctxInfo.file}:${span}（已选 ${ctxInfo.text.split('\n').length} 行）`;
}

// ---------------------------------------------------------------------------
// 侧栏 Chat：webview provider
// ---------------------------------------------------------------------------

class ChatViewProvider {
  /**
   * @param {vscode.ExtensionContext} context 扩展上下文（持久化用）
   * @param {{pushToAgents: Function}} hooks 复用的 Agents 桥接
   */
  constructor(context, hooks) {
    this.context = context;
    this.hooks = hooks;
    this.view = null;
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    /** chat.html 的磁盘绝对路径（读模板用，不走 webview URI）。 */
    this.mediaDir = path.join(context.extensionUri.fsPath, 'media');
    /** @type {any} 会话状态：保留在内存，持久化到 workspaceState。 */
    this.state = this.loadState();
    this.abort = null;
    this.streamingIndex = -1;
    this.effectiveModel = '';
  }

  /** 从 workspaceState 恢复（每个项目一份对话）。 */
  loadState() {
    const saved = this.context.workspaceState.get(STATE_KEY) || {};
    return {
      messages: Array.isArray(saved.messages) ? saved.messages.slice(-HISTORY_MAX) : [],
      provider: typeof saved.provider === 'string' ? saved.provider : '',
      model: typeof saved.model === 'string' ? saved.model : '',
      contextEnabled: saved.contextEnabled !== false,
      models: null,
      busy: false,
      error: '',
    };
  }

  /** 写回 workspaceState（fire-and-forget，失败不影响对话）。 */
  persist() {
    const { messages, provider, model, contextEnabled } = this.state;
    try {
      // 只留可序列化且有内容的部分，占位消息不落盘。
      const slim = messages
        .filter((m) => !m.pending && String(m.content || '').trim())
        .slice(-HISTORY_MAX)
        .map((m) => ({ role: m.role, content: m.content }));
      void this.context.workspaceState.update(STATE_KEY, { messages: slim, provider, model, contextEnabled });
    } catch { /* 持久化失败不阻断对话 */ }
  }

  /** 把完整状态推给 webview。 */
  postState() {
    const ctxInfo = collectContext();
    this.post({
      type: 'state',
      messages: this.state.messages,
      models: this.state.models,
      provider: this.state.provider,
      model: this.state.model,
      busy: this.state.busy,
      error: this.state.error,
      contextEnabled: this.state.contextEnabled,
      contextLabel: contextLabel(ctxInfo),
      hasEditor: Boolean(ctxInfo),
      effectiveModel: this.effectiveModel,
    });
  }

  post(message) {
    try { this.view?.webview.postMessage(message); } catch { /* 视图已销毁 */ }
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.mediaRoot],
    };
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, name)).toString();
    let html = '';
    try {
      html = fs.readFileSync(path.join(this.mediaDir, 'chat.html'), 'utf8');
    } catch {
      html = '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:16px">'
        + 'chat.html 缺失，请重装 DSH 编辑器模式扩展。</body>';
    }
    html = html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{markdownUri\}\}/g, uri('markdown.js'))
      .replace(/\{\{scriptUri\}\}/g, uri('chat.js'))
      .replace(/\{\{styleUri\}\}/g, uri('chat.css'));
    webview.html = html;

    webview.onDidReceiveMessage((message) => { void this.onMessage(message); });
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.postState(); });
    webviewView.onDidDispose(() => { this.view = null; });

    // 模型目录是异步的，先给 UI 一个空态，拿到后补发。
    this.postState();
    void this.refreshModels().then(() => this.postState());
  }

  /** 拉取 DSH 侧真实可用的模型列表；失败记到 error，不阻塞对话。 */
  async refreshModels() {
    try {
      const { status, json } = await getJson('/editor-chat/models');
      if (status !== 200 || !json) {
        this.state.models = null;
        return;
      }
      this.state.models = { default: json.default || null, providers: json.providers || [] };
      // 首次进入（或原选择已失效）时对齐到 DSH 的默认模型。
      const exists = this.modelExists(this.state.provider, this.state.model);
      if (!exists) {
        const fallback = json.default
          || (json.providers || []).map((p) => ({ provider: p.id, model: p.models?.[0]?.id }))[0];
        if (fallback?.provider) {
          this.state.provider = fallback.provider;
          this.state.model = fallback.model || '';
          this.persist();
        }
      }
      if (json.error) this.state.error = String(json.error);
    } catch (err) {
      this.state.models = null;
      this.state.error = `无法读取 DSH 模型列表：${String(err?.message || err)}`;
    }
  }

  modelExists(provider, model) {
    if (!provider || !model) return false;
    const providers = this.state.models?.providers || [];
    return providers.some((p) => p.id === provider && (p.models || []).some((m) => m.id === model));
  }

  async onMessage(message) {
    switch (message?.type) {
      case 'ready':
        this.postState();
        if (!this.state.models) { void this.refreshModels().then(() => this.postState()); }
        break;
      case 'send':
        await this.send(String(message.text || ''));
        break;
      case 'stop':
        await this.stop();
        break;
      case 'selectModel':
        this.state.provider = String(message.provider || '');
        this.state.model = String(message.model || '');
        this.persist();
        break;
      case 'toggleContext':
        this.state.contextEnabled = Boolean(message.enabled);
        this.persist();
        this.postState();
        break;
      case 'newChat':
        this.reset();
        break;
      case 'escalate':
        await this.escalate(Number(message.index));
        break;
      case 'refreshModels':
        await this.refreshModels();
        this.postState();
        break;
      case 'prefill':
        // 由命令「在 DSH Chat 中询问选中代码」触发，只填输入框不自动发送。
        this.post({ type: 'prefill', text: String(message.text || '') });
        break;
      case 'openFile':
        await this.openFile(String(message.path || ''), Number(message.line) || 1);
        break;
      default:
        break;
    }
  }

  /** 清空对话（保留模型选择）。 */
  reset() {
    if (this.abort) { try { this.abort.abort(); } catch { /* 已结束 */ } }
    this.abort = null;
    this.state.messages = [];
    this.state.busy = false;
    this.state.error = '';
    this.streamingIndex = -1;
    this.persist();
    this.postState();
  }

  /** 打开聊天记录里引用的文件并定位到行。 */
  async openFile(file, line) {
    if (!file) return;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const abs = path.isAbsolute(file) ? file : path.join(folder, file);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      vscode.window.showWarningMessage(`无法打开 ${file}：${String(err?.message || err)}`);
    }
  }

  /** 把一条助手回复交给 DSH Agents（复用已有选区桥）。 */
  async escalate(index) {
    const message = this.state.messages[index];
    if (!message || message.role !== 'assistant' || !String(message.content || '').trim()) {
      vscode.window.showInformationMessage('没有可发送的回复');
      return;
    }
    const ok = this.hooks.pushToAgents({
      file: '',
      line: 0,
      text: String(message.content).slice(0, 8000),
    });
    if (ok) vscode.window.setStatusBarMessage('已发送到 DSH Agents', 2000);
    else vscode.window.showWarningMessage('DSH Agents 通道未就绪');
  }

  /** 停止当前生成：先 abort 本地请求，再通知 DSH 侧中断上游。 */
  async stop() {
    if (!this.state.busy) return;
    const requestId = this.state.requestId;
    try { this.abort?.abort(); } catch { /* 已结束 */ }
    if (requestId) {
      try { await postJson('/editor-chat/abort', { requestId }, 5000); } catch { /* 通道已断 */ }
    }
  }

  /**
   * 发送一轮对话。
   * 流程：入队用户消息 → 建助手占位 → 流式追加 → 落盘。
   * 模型与上下文都取自用户当前配置，不在这里做任何默认值发明。
   */
  async send(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || this.state.busy) return;

    this.state.error = '';
    this.state.busy = true;
    this.state.messages.push({ role: 'user', content: trimmed });

    // 发给模型的 messages 不含这条空占位。
    const history = this.state.messages
      .filter((m) => String(m.content || '').trim())
      .slice(-HISTORY_MAX)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, MESSAGE_MAX) }));

    const index = this.state.messages.length;
    this.state.messages.push({ role: 'assistant', content: '', reasoning: '', pending: true });
    this.streamingIndex = index;

    const requestId = `r${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    this.state.requestId = requestId;
    this.abort = new AbortController();
    this.postState();

    const payload = {
      requestId,
      provider: this.state.provider,
      model: this.state.model,
      messages: history,
      context: this.state.contextEnabled ? (collectContext() || undefined) : undefined,
    };
    // history 已包含本轮的 user 消息；appendContext 在 Host 侧追加到这条上。
    let streamError = '';
    let finishKind = '';
    try {
      await streamChat(payload, {
        signal: this.abort.signal,
        onEvent: (event, data) => {
          if (this.state.requestId !== requestId) return;
          const target = this.state.messages[this.streamingIndex];
          if (!target) return;
          switch (event) {
            case 'meta':
              this.effectiveModel = `${data.provider}/${data.model}`;
              break;
            case 'delta':
              target.content += String(data.text || '');
              this.post({ type: 'delta', index: this.streamingIndex, text: String(data.text || '') });
              break;
            case 'reasoning':
              target.reasoning = String(target.reasoning || '') + String(data.text || '');
              this.post({ type: 'reasoning', index: this.streamingIndex, text: String(data.text || '') });
              break;
            case 'usage':
              target.usage = data;
              break;
            case 'finish':
              finishKind = String(data.kind || '');
              target.finish = finishKind;
              if (data.failure?.message) streamError = String(data.failure.message);
              break;
            case 'error':
              streamError = String(data.message || '未知错误');
              break;
            default:
              break;
          }
        },
      });
    } catch (err) {
      streamError = String(err?.message || err);
    }

    // 收尾：占位转正、状态归位、落盘。
    const final = this.state.messages[this.streamingIndex];
    if (final) {
      final.pending = false;
      if (!String(final.content || '').trim() && !streamError) {
        streamError = finishKind === 'aborted' ? '已停止' : '模型没有返回内容';
      }
    }
    this.state.busy = false;
    this.state.requestId = '';
    this.abort = null;
    this.streamingIndex = -1;
    if (streamError) this.state.error = streamError;
    this.trimHistory();
    this.persist();
    this.postState();
  }

  /** 只保留最近 HISTORY_MAX 条，且不切断「user/assistant」配对。 */
  trimHistory() {
    const messages = this.state.messages.filter((m) => !m.pending);
    if (messages.length <= HISTORY_MAX) { this.state.messages = messages; return; }
    let start = messages.length - HISTORY_MAX;
    // 若切点落在 assistant 上，往后再丢一条，保证以 user 开始。
    while (start < messages.length && messages[start].role !== 'user') start++;
    this.state.messages = messages.slice(start);
  }
}

// ---------------------------------------------------------------------------
// 选区 → Agents（原有能力）
// ---------------------------------------------------------------------------

/** POST 到 DSH 桥接端点；失败只记日志，不打断用户操作。 */
function pushToAgents(payload) {
  const { pushUrl, token } = channel();
  if (!pushUrl || !token) return false;
  try {
    const target = new URL(pushUrl);
    const lib = target.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      token,
      file: payload.file,
      line: payload.line,
      text: payload.text,
    });
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
    return true;
  } catch {
    return false;
  }
}

/** 从当前活动编辑器收集文件、行号、选区文本。 */
function collect(includeSelection) {
  const info = collectContext();
  if (!info) return null;
  const text = includeSelection && info.hasSelection ? info.text : '';
  return { file: info.file, line: info.line, text };
}

/** 格式化要送进 Agents 输入框的文本。 */
function formatPayload(file, line, text) {
  const loc = file ? `@${file}${line ? `:${line}` : ''}` : '';
  if (!text) return loc ? `请看一下 ${loc}` : '';
  return `${loc ? `${loc}\n` : ''}\`\`\`\n${text}\n\`\`\`\n`;
}

function activate(context) {
  // 命令与 webview 都要用，先建单例（视图是按需 resolve 的）。
  const provider = new ChatViewProvider(context, { pushToAgents });

  const send = (includeSelection) => {
    const data = collect(includeSelection);
    if (!data) {
      vscode.window.showInformationMessage('没有打开的编辑器');
      return;
    }
    const formatted = formatPayload(data.file, data.line, data.text);
    if (pushToAgents({ file: data.file, line: data.line, text: formatted })) {
      vscode.window.setStatusBarMessage('已发送给 DSH Agents', 2000);
    } else {
      vscode.window.showWarningMessage('DSH Agents 通道未就绪');
    }
  };

  /** 把选区连同「请解释/修改」的引子填进侧栏 Chat 输入框。 */
  const askSelection = async () => {
    const info = collectContext();
    await vscode.commands.executeCommand('dshEditor.chat.focus');
    if (!info || !info.hasSelection) {
      vscode.window.showInformationMessage('先选中一段代码再提问');
      return;
    }
    const snippet = info.text.length > 4000 ? `${info.text.slice(0, 4000)}\n…` : info.text;
    const text = `${info.file}:${info.line} 这段代码在做什么？有哪些问题？\n\n\`\`\`${info.language}\n${snippet}\n\`\`\`\n`;
    provider.post({ type: 'prefill', text });
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dshEditorBridge.sendSelection', () => send(true)),
    vscode.commands.registerCommand('dshEditorBridge.sendFile', () => send(false)),
    vscode.commands.registerCommand('dshEditorBridge.askSelection', () => { void askSelection(); }),
    vscode.commands.registerCommand('dshEditorBridge.newChat', () => {
      provider.reset();
      void vscode.commands.executeCommand('dshEditor.chat.focus');
    }),
    vscode.commands.registerCommand('dshEditorBridge.focusChat', () => {
      void vscode.commands.executeCommand('dshEditor.chat.focus');
    }),
  );

  // 编辑器切换/选区变化时刷新上下文提示，让用户清楚这一问会带什么上下文。
  let timer = null;
  const scheduleContext = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!provider.view) return;
      const info = collectContext();
      provider.post({
        type: 'contextInfo',
        label: contextLabel(info),
        hasEditor: Boolean(info),
        hasSelection: Boolean(info && info.hasSelection),
      });
    }, 150);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(scheduleContext),
    vscode.window.onDidChangeTextEditorSelection(scheduleContext),
    { dispose: () => { if (timer) clearTimeout(timer); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate, formatPayload, parseSseBlock, channel };