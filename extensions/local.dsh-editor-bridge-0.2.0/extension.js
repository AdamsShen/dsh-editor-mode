/**
 * DSH Editor Bridge —— VS Code 扩展（Node 扩展主机）。
 *
 * 四个能力：
 *  1. 侧栏 Chat：webview 视图，**是 DSH 真实 Agent 会话的第二个视图**
 *     （2026-11 起，不再是独立纯模型对话）。消息走 /editor-sessions/*，
 *     所以编辑器里问过的问题，切到 DSH Agents 模式能看到同一条会话。
 *  2. 历史面板：另一个 webview 视图，列出**全部工作区**的会话，可搜索、可切换。
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
const sessionView = require('./session-view.js');


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
   * @param {vscode.ExtensionContext} context 扩展上下文
   * @param {{pushToAgents: Function}} hooks 复用的 Agents 桥接
   */
  constructor(context, hooks) {
    this.context = context;
    this.hooks = hooks;
    this.view = null;
    this.visibleId = '';
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.mediaDir = path.join(context.extensionUri.fsPath, 'media');
    /** 当前绑定的 DSH 会话 id（空=还没建）。 */
    this.sessionId = '';
    this.sessionTitle = '';
    this.messages = [];
    this.busy = false;
    this.error = '';
    this.abort = null;
    /** 正在累积的助手消息下标；-1 表示当前没有进行中的回复。 */
    this.streamingIndex = -1;
    this.sessions = [];
  }

  visibleViewId() { return this.visibleId || ''; }

  post(message) {
    try { this.view?.webview.postMessage(message); } catch { /* 视图已销毁 */ }
  }

  /** 当前完整状态（webview 只依赖这一个来源渲染）。 */
  snapshot() {
    const ctxInfo = collectContext();
    return {
      type: 'state',
      sessionId: this.sessionId,
      sessionTitle: this.sessionTitle,
      messages: this.messages,
      busy: this.busy,
      error: this.error,
      contextLabel: contextLabel(ctxInfo),
      hasEditor: Boolean(ctxInfo),
    };
  }

  postState() { this.post(this.snapshot()); }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    this.visibleId = webviewView.viewType || VIEW_ID;
    const webview = webviewView.webview;
    webview.options = { enableScripts: true, localResourceRoots: [this.mediaRoot] };
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
    const track = (visible) => {
      if (!visible) return;
      this.visibleId = webviewView.viewType || VIEW_ID;
      this.postState();
      // 双模式 X：切回编辑器时要看到「在 Agents 侧继续过的」同一会话，
      // 所以重新加载历史并重挂实时流，而不是沿用上次的内存快照。
      void this.refreshOnShow();
    };
    track(webviewView.visible !== false);
    webviewView.onDidChangeVisibility(() => { track(webviewView.visible); });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = null;
      if (this.visibleId === (webviewView.viewType || VIEW_ID)) this.visibleId = '';
    });
    this.postState();
  }

  /** 统一的错误提示。 */
  fail(err) {
    this.error = String(err?.message || err);
    this.busy = false;
    this.postState();
  }

  /** 为当前工作区建一个会话（DSH 侧复用空白会话，不会堆空壳）。 */
  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const { status, json } = await sessionView.request(channel(), 'POST', '/editor-sessions/create', { cwd });
    if (status !== 200 || !json?.sessionId) {
      throw new Error(json?.error || `无法创建会话（HTTP ${status}）`);
    }
    this.sessionId = String(json.sessionId);
    this.sessionTitle = '';
    this.messages = [];
    this.postState();
    return this.sessionId;
  }

  async onMessage(message) {
    switch (message?.type) {
      case 'ready':
        this.postState();
        void this.listSessions();
        break;
      case 'send':
        await this.send(String(message.text || ''));
        break;
      case 'stop':
        await this.stop();
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'selectSession':
        await this.selectSession(String(message.sessionId || ''));
        break;
      case 'renameSession':
        await this.renameSession(String(message.title || ''));
        break;
      case 'listSessions':
        await this.listSessions();
        // 历史覆盖层要的是「全部工作区」的完整清单，不是 tab 兜底用的最近列表
        if (message.all) await this.sendAllSessions('');
        break;
      case 'searchSessions':
        await this.sendAllSessions(String(message.q || ''));
        break;
      case 'openSession':
        // 点历史条目：作为新 tab 向右追加并打开
        await this.selectSession(String(message.sessionId || ''), String(message.title || ''));
        break;
      case 'prefill':
        this.post({ type: 'prefill', text: String(message.text || '') });
        break;
      case 'openFile':
        await this.openFile(String(message.path || ''), Number(message.line) || 1);
        break;
      default:
        break;
    }
  }

  /**
   * 视图重新可见时同步一次：历史可能有变化（用户在 Agents 侧继续聊过），
   * 实时流可能已断（切走期间不会有人消费）。
   */
  async refreshOnShow() {
    if (!this.sessionId) { await this.listSessions(); return; }
    await this.loadHistory();
    if (!this.busy) this.attach();
    await this.listSessions();
    this.syncTitle();
    this.postState();
  }

  /** 拉会话列表（tab 标题兜底用，仅最近一批）。 */
  async listSessions() {
    try {
      const { status, json } = await sessionView.request(channel(), 'GET', '/editor-sessions/list');
      if (status !== 200) throw new Error(json?.error || `HTTP ${status}`);
      this.sessions = Array.isArray(json?.items) ? json.items : [];
      this.post({ type: 'sessions', items: this.sessions });
    } catch (err) {
      this.post({ type: 'sessions', items: [], error: String(err?.message || err) });
    }
  }

  /**
   * 拉「全部工作区」会话给历史覆盖层。
   * 有查询词走 DSH 的跨会话 search，否则走 list（list 本身就是全量）。
   * 与 tab 用的 sessions 消息分开，避免历史面板把上百条塞进 tab 条。
   */
  async sendAllSessions(query) {
    try {
      const path = query
        ? `/editor-sessions/search?q=${encodeURIComponent(query)}`
        : '/editor-sessions/list';
      const { status, json } = await sessionView.request(channel(), 'GET', path);
      if (status !== 200) throw new Error(json?.error || `HTTP ${status}`);
      this.post({ type: 'allSessions', items: Array.isArray(json?.items) ? json.items : [] });
    } catch (err) {
      this.post({ type: 'allSessions', items: [], error: String(err?.message || err) });
    }
  }

  /** 新建一条会话（真建，不是清空数组）；新 id 会让前端 tab 条向右追加。 */
  async newChat() {
    this.detach();
    // 不先推一个「无会话」的空态：那会让 tab 条闪一下。
    // 直接建会话，ensureSession 拿到 id 后一次 state 推送即可追加新 tab。
    this.sessionId = '';
    this.sessionTitle = '';
    this.messages = [];
    this.error = '';
    try { await this.ensureSession(); } catch (err) { this.fail(err); }
    await this.listSessions();
  }

  /**
   * 切到指定会话：先读历史，再挂上实时流。
   * @param {string} sessionId 会话 id
   * @param {string} [knownTitle] 从历史列表带来的标题，让新 tab 立刻有名字
   */
  async selectSession(sessionId, knownTitle = '') {
    if (!sessionId || sessionId === this.sessionId) return;
    this.detach();
    this.sessionId = sessionId;
    this.sessionTitle = knownTitle || '';
    this.messages = [];
    this.error = '';
    this.postState();
    await this.loadHistory();
    this.attach();
    await this.listSessions();
  }

  /** 读历史页并折叠成消息。 */
  async loadHistory() {
    if (!this.sessionId) return;
    try {
      const { status, json } = await sessionView.request(
        channel(), 'GET', `/editor-sessions/history?sessionId=${encodeURIComponent(this.sessionId)}`,
      );
      if (status !== 200) throw new Error(json?.error || `HTTP ${status}`);
      const events = Array.isArray(json?.events) ? json.events : [];
      this.messages = sessionView.foldEvents(events);
      this.postState();
    } catch (err) {
      this.fail(err);
    }
  }

  /** 把标题改成会话真实标题（从列表里取）。 */
  syncTitle() {
    const found = this.sessions.find((s) => s.id === this.sessionId);
    if (found?.title) this.sessionTitle = found.title;
  }

  async renameSession(title) {
    if (!this.sessionId || !title.trim()) return;
    try {
      const { status, json } = await sessionView.request(
        channel(), 'POST', '/editor-sessions/rename', { sessionId: this.sessionId, title: title.trim() },
      );
      if (status !== 200) throw new Error(json?.error || `HTTP ${status}`);
      this.sessionTitle = title.trim();
      this.postState();
      await this.listSessions();
    } catch (err) { this.fail(err); }
  }

  /** 卸掉实时流，避免切会话后旧流继续往新会话里灌数据。 */
  detach() {
    if (this.abort) { try { this.abort.abort(); } catch { /* 已结束 */ } }
    this.abort = null;
    this.streamingIndex = -1;
    this.busy = false;
  }

  /** 发送一轮：先 prompt，再靠实时流把过程和结果画出来。 */
  async send(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || this.busy) return;
    this.error = '';
    this.busy = true;
    // 乐观展示用户消息：不等会话事件回显，点击即有反馈。
    this.messages.push({ role: 'user', parts: [{ type: 'text', text: trimmed }], reasoning: '' });
    this.postState();

    try {
      await this.ensureSession();
      const { status, json } = await sessionView.request(
        channel(), 'POST', '/editor-sessions/prompt',
        { sessionId: this.sessionId, text: trimmed },
      );
      if (status !== 200) throw new Error(json?.error || `HTTP ${status}`);
      this.attach();
    } catch (err) {
      this.fail(err);
    }
  }

  /** 挂上实时流；已在跑就先卸掉旧的。 */
  attach() {
    if (!this.sessionId) return;
    if (this.abort) { try { this.abort.abort(); } catch { /* 已结束 */ } }
    this.abort = new AbortController();
    const sessionId = this.sessionId;
    const controller = this.abort;
    void sessionView.streamSession(channel(), sessionId, {
      signal: controller.signal,
      onEvent: (event, data) => this.onStreamEvent(sessionId, event, data),
    }).catch((err) => {
      // 主动 abort 不算错误
      if (controller.signal.aborted) return;
      this.error = String(err?.message || err);
      this.busy = false;
      this.postState();
    });
  }

  /** 实时流的单帧处理：文字增量就地追加，工具事件单独成卡。 */
  onStreamEvent(sessionId, event, data) {
    if (sessionId !== this.sessionId) return; // 旧流的尾巴，丢弃
    switch (event) {
      case 'snapshot': {
        // 重连时的开篇快照：用折叠结果覆盖，保证与服务端一致。
        const events = Array.isArray(data?.events) ? data.events : [];
        if (events.length) {
          const folded = sessionView.foldEvents(events);
          if (folded.length) this.messages = folded;
        }
        this.postState();
        break;
      }
      case 'assistant-start':
        this.busy = true;
        this.streamingIndex = this.ensureAssistant();
        this.postState();
        break;
      case 'assistant-chunk': {
        const chunk = data || {};
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          const index = this.ensureAssistant();
          const msg = this.messages[index];
          const last = msg.parts[msg.parts.length - 1];
          if (last && last.type === 'text') last.text += chunk.text;
          else msg.parts.push({ type: 'text', text: chunk.text });
          this.post({ type: 'append', index, text: chunk.text });
        } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          const index = this.ensureAssistant();
          this.messages[index].reasoning += chunk.text;
          this.post({ type: 'reasoning', index, text: chunk.text });
        } else if (chunk.type === 'tool-call-delta') {
          // 参数增量：这里不逐字画，等 assistant/message 事件的完整块。
          break;
        }
        break;
      }
      case 'session-event': {
        const type = String(data?.type || '');
        const payload = data?.data || {};
        if (type === 'tool/call') {
          const index = this.ensureAssistant();
          const callId = String(payload.callId || '');
          const msg = this.messages[index];
          if (!msg.parts.some((p) => p.type === 'tool' && p.callId === callId)) {
            msg.parts.push({
              type: 'tool',
              callId,
              name: String(payload.toolName || payload.name || '工具'),
              summary: sessionView.formatArgs(payload.arguments ?? payload.input),
              result: '',
              status: 'running',
            });
            this.postState();
          }
        } else if (type === 'tool/result') {
          const callId = String(payload.message?.source?.callId || payload.callId || '');
          const tool = this.findTool(callId);
          if (tool) {
            tool.status = payload.message?.isError ? 'error' : 'done';
            tool.result = sessionView.summarizeToolResult(payload.message?.content);
            this.postState();
          }
        } else if (type === 'turn/end') {
          for (const msg of this.messages) {
            for (const part of msg.parts || []) {
              if (part.type === 'tool' && part.status === 'running') part.status = 'done';
            }
          }
          this.busy = false;
          this.streamingIndex = -1;
          this.postState();
          void this.listSessions();
        } else if (type === 'session/title') {
          this.sessionTitle = String(payload.title || '');
          this.postState();
        }
        break;
      }
      case 'error':
        this.error = String(data?.message || '会话流出错');
        this.busy = false;
        this.postState();
        break;
      default:
        break;
    }
  }

  /** 找到（或新建）一条助手消息并返回其下标。 */
  ensureAssistant() {
    if (this.streamingIndex >= 0 && this.messages[this.streamingIndex]?.role === 'assistant') {
      return this.streamingIndex;
    }
    this.messages.push({ role: 'assistant', parts: [], reasoning: '' });
    this.streamingIndex = this.messages.length - 1;
    return this.streamingIndex;
  }

  /** 按 callId 找工具卡片。 */
  findTool(callId) {
    for (const msg of this.messages) {
      for (const part of msg.parts || []) {
        if (part.type === 'tool' && part.callId === callId) return part;
      }
    }
    return null;
  }

  /** 停止当前回合：走 DSH 自己的 cancel，保证服务端真的停。 */
  async stop() {
    if (!this.sessionId) return;
    try {
      await sessionView.request(channel(), 'POST', '/editor-sessions/cancel', { sessionId: this.sessionId });
    } catch { /* 通道已断也要把 UI 复位 */ }
    this.detach();
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
      void provider.newChat();
      void vscode.commands.executeCommand('dshEditor.chat.focus');
    }),
    // 两个容器（左侧活动栏 + 右侧次级侧栏）挂的是同一个视图 id，
    // 没有显式容器时 executeCommand 会把右侧那栏一起掀出来，所以先按可见性挑一个。
    vscode.commands.registerCommand('dshEditorBridge.focusChat', () => {
      const id = provider.visibleViewId() || VIEW_ID;
      void vscode.commands.executeCommand(`${id}.focus`);
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

module.exports = {
  activate,
  deactivate,
  formatPayload,
  parseSseBlock,
  channel,
  foldEvents: sessionView.foldEvents,
};