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

/**
 * 「AI 改动」虚拟文档的 scheme。
 *
 * 为什么用虚拟文档而不是临时文件：vscode.diff 需要两份可寻址的文档，
 * 而「改动前」的内容只存在于 DSH 的改动记录里（磁盘上没有）。
 * 注册一个只读 provider 按 key 取文本，既不用落盘，也不用管清理，
 * 这也是 CodeBuddy（genie-diff）用的同一套机制。
 */
const DIFF_SCHEME = 'dsh-changes';

/** key → 文本。provider 只服务内存里已登记的内容，不落盘。 */
const diffDocuments = new Map();

/**
 * 内存里最多保留多少份虚拟文档（before + after 各算一份）。
 *
 * 为什么必须设上限：每份是整文件文本，一个 500KB 的文件开一次 diff 就占 1MB。
 * 长会话里不断点开不同文件会持续累积。diff 编辑器一旦打开，VS Code 会自己
 * 缓存文档内容，所以这里的条目只用于「首次取内容」，回收是安全的。
 */
const DIFF_DOC_MAX = 32;

/** 单调递增的 key 序列，避免同一毫秒内两次打开互相覆盖。 */
let diffDocSeq = 0;

/** 登记一份虚拟文档内容，并淘汰最旧的，保证内存有界。 */
function rememberDiffDoc(key, text) {
  diffDocuments.set(key, text);
  while (diffDocuments.size > DIFF_DOC_MAX) {
    const oldest = diffDocuments.keys().next();
    if (oldest.done) break;
    diffDocuments.delete(oldest.value);
  }
}

/** 虚拟文档 provider：只读、按 key 取文本，未登记返回空串。 */
const diffContentProvider = {
  provideTextDocumentContent(uri) {
    const text = diffDocuments.get(uri.path) ?? '';
    return text;
  },
};


const VIEW_ID = 'dshEditor.chat';
const STATE_KEY = 'dshEditor.chat.v1';
/** 持久化的对话上限（条）。超出从最旧的丢，避免 globalState 无限膨胀。 */
const HISTORY_MAX = 60;
// 发给 DSH Agents 的正文上限，必须与 Host 的 BRIDGE_TEXT_MAX（index.js:708）一致。
// 客户端不先按它裁剪的话，超长内容会被 Host 从中间直接切断，
// 结果可能是半行代码或半条路径——看起来像内容损坏。
const BRIDGE_TEXT_LIMIT = 8000;

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
  // 非 file 协议（如 diff 虚拟文档）保留完整 uri；file 走统一相对化，
  // 避免与 toWorkspacePath 出现两套不一致的路径口径。
  const file = fsPath ? toWorkspacePath(fsPath) : doc.uri.toString();
  const sel = editor.selection;
  const hasSelection = Boolean(sel && !sel.isEmpty);
  const text = hasSelection ? doc.getText(sel).slice(0, BRIDGE_TEXT_LIMIT) : '';
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

    // 兜住任何处理器冒出来的异常：这里是 void 调用，不接住就会变成
// 未处理的 Promise 拒绝（扩展宿主只写日志，用户毫无反馈）。
    webview.onDidReceiveMessage((message) => {
      void this.onMessage(message).catch((err) => {
        this.error = String(err?.message || err);
        this.postState();
      });
    });
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
      case 'openChangeDiff':
        await this.openChangeDiff(
          String(message.sessionId || this.sessionId || ''),
          Number(message.seq),
          Number(message.index),
        );
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
    // 加载代号：并发加载（快速切 tab、视图刚显示又刷新）时，
    // 只让最新一次生效，避免旧响应把新列表覆盖掉。
    const me = (this.historyGen = (this.historyGen || 0) + 1);
    try {
      const { status, json } = await sessionView.request(
        channel(), 'GET', `/editor-sessions/history?sessionId=${encodeURIComponent(this.sessionId)}`,
      );
      if (status !== 200) throw new Error(json?.error || `HTTP ${status}`);
      if (me !== this.historyGen) return; // 已有更新的加载，丢弃这份过期结果
      const events = Array.isArray(json?.events) ? json.events : [];
      this.messages = sessionView.foldEvents(events);
      this.postState();
      // 折叠出来的改动卡片只有 seq 占位，文件列表要再查（同一个 seq 并发去重）。
      void this.fillPendingChanges(me);
    } catch (err) {
      if (me !== this.historyGen) return;
      this.fail(err);
    }
  }

  /**
   * 补全历史里所有 pending 的改动卡片。
   *
   * 为什么单独一趟：foldEvents 保持纯函数（不碰网络），
   * 而 summary 必须按 (sessionId, seq) 逐个取。
   * 取不到的（记录已过期）就保持 pending=false + files 为空，
   * 由前端显示「记录已过期」而不是一张空卡。
   */
  async fillPendingChanges(gen) {
    if (!this.sessionId) return;
    const targets = [];
    for (const msg of this.messages) {
      for (const part of msg.parts || []) {
        if (part.type === 'changes' && part.pending) targets.push(part);
      }
    }
    if (targets.length === 0) return;
    await Promise.all(targets.map(async (part) => {
      try {
        const res = await sessionView.fetchChanges(channel(), this.sessionId, part.seq);
        part.pending = false;
        if (res.status !== 200) {
          // 区分失败原因：503 是「DSH 没提供这个服务」，404 才是记录过期。
          // 之前一律显示「已过期」，排查时会把人带偏。
          part.emptyReason = res.status === 404 ? 'expired'
            : res.status === 503 ? 'unavailable' : 'failed';
          return;
        }
        const files = Array.isArray(res.json?.files) ? res.json.files : [];
        if (files.length === 0) part.emptyReason = 'none';
        part.turn = Number(res.json?.turn) || part.turn;
        part.added = Number(res.json?.added) || 0;
        part.deleted = Number(res.json?.deleted) || 0;
        part.total = Number(res.json?.total) || files.length;
        part.files = files.map((f) => ({
          path: String(f?.path || ''),
          display: String(f?.display || f?.path || ''),
          added: Number(f?.added) || 0,
          deleted: Number(f?.deleted) || 0,
          binary: f?.binary === true,
          oversized: f?.oversized === true,
        }));
      } catch {
        part.pending = false;
        part.emptyReason = 'failed';
      }
    }));
    // 期间若有更新的加载把 this.messages 整个换掉了，这里补全作用在已废弃的
    // 对象上；再 postState 会把新列表里仍处于 pending 的卡片重新画一次，
    // 表现是「永远停在正在读取」。交给最新那一代去补。
    if (gen !== undefined && gen !== this.historyGen) return;
    this.postState();
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
          if (folded.length) {
            this.messages = folded;
            // 折叠出来的改动卡片只有 seq 占位（pending），必须补全文件列表，
            // 否则重连后这些卡会永远停在「正在读取改动…」——只有 loadHistory
            // 会补，而重连走的是 snapshot，不是 loadHistory。
            // 顺带自增代号，让更早那轮 loadHistory 的补全结果作废。
            const gen = (this.historyGen = (this.historyGen || 0) + 1);
            void this.fillPendingChanges(gen);
          }
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
        } else if (type === 'workspace/changes') {
          // 事件本身只有 {turn}，文件列表要按 (sessionId, seq) 再查一次。
          void this.attachChanges(Number(data?.seq));
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

  /**
   * 改动文件里的 `path` 是相对「该会话的 cwd」的，不是相对当前编辑器工作区。
   *
   * 为什么不能直接用 workspaceFolders[0]：历史覆盖层列出的是**全部工作区**的
   * 会话，从别的工作区打开一条会话再看改动，基准目录就错了，会读到错误的文件
   * （或者读不到）。会话 cwd 在 /editor-sessions/list 的 items 里就有。
   *
   * @param {string} sessionId
   * @returns {string} 解析相对路径用的基准目录
   */
  baseDirFor(sessionId) {
    const hit = (this.sessions || []).find((s) => s && s.id === sessionId);
    const cwd = typeof hit?.cwd === 'string' ? hit.cwd : '';
    if (cwd) return cwd;
    // 会话列表还没加载（或该会话不在最近一页）时退回当前工作区。
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  }

  /**
   * 打开某个改动文件的原生前后对比。
   *
   * 数据来源与形状（DSH workspaceChanges.diff）：
   *   { kind:'text', path, display, before:boolean, after:boolean, hunks, coarse }
   * `before`/`after` 只表示该侧是否存在，**不是内容**；内容靠
   * 「磁盘当前内容 + hunks 反推」还原（见 session-view.invertHunks）。
   *
   * @param {string} sessionId 会话 id
   * @param {number} seq       workspace/changes 事件的序列号
   * @param {number} index     文件在 summary.files 里的下标
   */
  async openChangeDiff(sessionId, seq, index) {
    if (!sessionId || !Number.isSafeInteger(seq) || !Number.isSafeInteger(index)) return;
    let payload;
    try {
      const { status, json } = await sessionView.fetchChangeDiff(channel(), sessionId, seq, index);
      if (status !== 200) {
        vscode.window.showWarningMessage(
          status === 404 ? '该改动的记录已过期，无法对比' : `无法获取改动对比：${json?.error || status}`,
        );
        return;
      }
      payload = json;
    } catch (err) {
      vscode.window.showWarningMessage(`无法获取改动对比：${String(err?.message || err)}`);
      return;
    }

    const file = String(payload?.path || '');
    const display = String(payload?.display || file);
    // 二进制 / 文件过大 / 被拒绝：给明确提示，不假装能对比。
    if (payload?.kind !== 'text') {
      const reason = payload?.kind === 'binary'
        ? '二进制文件，无法预览差异'
        : payload?.kind === 'oversized' ? '文件过大，无法预览差异' : '该文件不支持差异预览';
      vscode.window.showInformationMessage(`${display}：${reason}`);
      return;
    }

    const folder = this.baseDirFor(sessionId);
    const abs = path.isAbsolute(file) ? file : path.join(folder, file);

    // 新文件（before=false）：左侧为空文档。其余情况反推改动前内容。
    const afterExists = payload?.after !== false;
    const beforeExists = payload?.before !== false;
    // after 侧直接用磁盘原文，避免「切行再拼回」丢掉末尾换行。
    // 切行必须与 DSH 同口径（保留 CRLF 的 \r），否则 hunks 对不上磁盘。
    let afterText = '';
    let afterLines = [];
    if (afterExists) {
      try {
        afterText = fs.readFileSync(abs, 'utf8');
      } catch {
        vscode.window.showWarningMessage(`无法读取 ${display} 的当前内容`);
        return;
      }
      afterLines = sessionView.splitLines(afterText);
    }
    // 该轮之后文件若又被改过，hunks 与磁盘内容对不上：
    // 此时左（hunks 反推）右（磁盘）不是同一时刻的两个版本，
    // 硬拼会展示一份把「本轮改动」和「后续改动」混在一起的假 diff。
    if (beforeExists && !sessionView.hunksMatchContent(afterLines, payload?.hunks)) {
      vscode.window.showWarningMessage(
        `${display} 在该轮之后又被修改过，无法精确对比本轮改动`,
      );
      return;
    }

    // before 侧由 hunks 反推；末尾换行跟随 after（同一文件通常不变）。
    const beforeLines = beforeExists
      ? sessionView.invertHunks(afterLines, payload?.hunks)
      : [];
    const beforeText = beforeExists
      ? beforeLines.join('\n') + (afterText.endsWith('\n') ? '\n' : '')
      : '';

    // key 用单调序号：同一毫秒内连点两次也不会互相覆盖（时间戳会）。
    diffDocSeq += 1;
    const stamp = `${diffDocSeq}-${index}`;
    const beforeKey = `/before/${stamp}`;
    const afterKey = `/after/${stamp}`;
    rememberDiffDoc(beforeKey, beforeText);
    rememberDiffDoc(afterKey, afterText);

    const title = `${display}（DSH 改动）`;
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: beforeKey, query: title });
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: afterKey, query: title });
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
    } catch (err) {
      // vscode.diff 缺席或差异编辑器拒绝打开时，不能让它变成未处理的
      // Promise 拒绝（onMessage 是 void 调用）：否则用户点了一下、什么也没发生。
      vscode.window.showWarningMessage(`无法打开对比：${String(err?.message || err)}`);
    }
  }

  /**
   * 改动卡片该挂到哪条助手消息。
   *
   * 为什么不能直接用 ensureAssistant()：`workspace/changes` 可能晚于
   * `turn/end` 到达（DSH 不保证顺序），而 turn/end 会把 streamingIndex 清成 -1。
   * 此时 ensureAssistant() 会新开一条只有卡片的空气泡，并把 streamingIndex
   * 指向它 —— 下一轮的正文于是被追进这条带旧卡片的空气泡，改动算错回合。
   *
   * 复用已有消息时**不修改 streamingIndex**，避免同样的串轮。
   *
   * @returns {number} 目标助手消息的下标
   */
  assistantIndexForChanges() {
    if (this.streamingIndex >= 0) {
      const current = this.messages[this.streamingIndex];
      if (current && current.role === 'assistant') return this.streamingIndex;
    }
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i]?.role === 'assistant') return i;
    }
    return this.ensureAssistant();
  }

  /**
   * 收到 workspace/changes 后拉一次文件列表，挂到当前助手消息上。
   *
   * 为什么要单独拉：事件里只有 turn，没有文件；这是 DSH 的既定契约。
   * 拉失败不打断对话（静默），因为改动卡片只是增强信息。
   *
   * @param {number} seq workspace/changes 事件的序列号
   */
  async attachChanges(seq) {
    if (!this.sessionId || !Number.isSafeInteger(seq) || seq < 0) return;
    // 固定「发起这次查询的会话」：await 期间用户可能切了会话（历史覆盖层
    // 支持跨工作区切换），不固定的话会把上一条会话的改动卡片挂到新会话的
    // 消息列表上——而且 seq 属于另一个会话，卡片内容也对不上。
    const sessionId = this.sessionId;
    let json;
    try {
      const res = await sessionView.fetchChanges(channel(), sessionId, seq);
      if (res.status !== 200) return;
      json = res.json;
    } catch { return; }
    if (this.sessionId !== sessionId) return;
    const files = Array.isArray(json?.files) ? json.files : [];
    if (files.length === 0) return;
    const index = this.assistantIndexForChanges();
    const msg = this.messages[index];
    // 同一次改动只挂一张卡
    if (msg.parts.some((p) => p.type === 'changes' && p.seq === seq)) return;
    msg.parts.push({
      type: 'changes',
      seq,
      turn: Number(json?.turn) || 0,
      added: Number(json?.added) || 0,
      deleted: Number(json?.deleted) || 0,
      total: Number(json?.total) || files.length,
      files: files.map((f) => ({
        path: String(f?.path || ''),
        display: String(f?.display || f?.path || ''),
        added: Number(f?.added) || 0,
        deleted: Number(f?.deleted) || 0,
        binary: f?.binary === true,
        oversized: f?.oversized === true,
      })),
    });
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

// ---------------------------------------------------------------------------
// 项目规则：DSH 原生读 AGENTS.md / CLAUDE.md，这里只负责把旧约定搬过来
// ---------------------------------------------------------------------------

/**
 * Cursor / Copilot 时代的规则文件。DSH 的 `agent-instructions` 只认
 * `AGENTS.md` / `CLAUDE.md`（含 `.local` 覆盖），这些文件它读不到，
 * 所以从 Cursor 迁过来的人会「规则突然不生效」。
 */
const LEGACY_RULE_FILES = ['.cursorrules', '.github/copilot-instructions.md', 'CODEBUDDY.md'];

/** 导入段落用固定标记包裹，便于重复执行时跳过、也便于人工识别来源。 */
const RULE_MARK = (rel) => `<!-- dsh-import: ${rel} -->`;

/**
 * 扫描工作区根部的旧规则文件，返回 [{ rel, abs, content }]。
 * 只读不写；`.cursor/rules/*.mdc` 一并纳入（Cursor 新版目录式规则）。
 *
 * @param {string} root 工作区根目录绝对路径
 * @returns {{rel: string, abs: string, content: string}[]}
 */
function readLegacyRuleFiles(root) {
  const targets = LEGACY_RULE_FILES.map((rel) => ({ rel, abs: path.join(root, rel) }));
  try {
    const dir = path.join(root, '.cursor', 'rules');
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.mdc')) {
        targets.push({ rel: `.cursor/rules/${name}`, abs: path.join(dir, name) });
      }
    }
  } catch { /* 没有目录式规则 */ }

  const found = [];
  for (const t of targets) {
    try {
      if (!fs.statSync(t.abs).isFile()) continue;
      const content = fs.readFileSync(t.abs, 'utf8');
      if (content.trim()) found.push({ ...t, content });
    } catch { /* 不存在或不可读，跳过 */ }
  }
  return found;
}

/**
 * 去掉 Cursor `.mdc` 顶部的 YAML frontmatter。
 *
 * 为什么必须去：`.mdc` 的 frontmatter 是 Cursor 专有语义
 * （`globs` 决定作用范围、`alwaysApply` 决定是否常驻），DSH 完全不认。
 * 原样搬进 AGENTS.md 只会让模型读到一段像分隔线又像 YAML 的噪声。
 *
 * @param {string} text
 * @returns {{body: string, stripped: boolean}}
 */
function stripMdcFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (!match) return { body: text, stripped: false };
  return { body: text.slice(match[0].length), stripped: true };
}

/**
 * 把旧规则文件导入工作区根的 `AGENTS.md`。
 *
 * 为什么是「导入」而不是「每次发消息注入」：DSH 已把 AGENTS.md 作为持久上下文
 * 加载，自己再拼一份会重复注入并打乱它的优先级（项目 > 全局）。
 *
 * 非破坏性：只追加、不覆盖；带标记的段落不会重复写入。
 * 已导入的来源即使内容更新也不会重写——避免覆盖用户手改过的版本。
 *
 * @param {string} root 工作区根目录绝对路径
 * @returns {{imported: string[], skipped: string[], target: string}}
 */
function importLegacyRules(root) {
  const target = path.join(root, 'AGENTS.md');
  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch { /* 首次创建 */ }

  const imported = [];
  const skipped = [];
  let next = existing;

  for (const file of readLegacyRuleFiles(root)) {
    if (next.includes(RULE_MARK(file.rel))) { skipped.push(file.rel); continue; }
    const isMdc = file.rel.endsWith('.mdc');
    const { body, stripped } = isMdc
      ? stripMdcFrontmatter(file.content)
      : { body: file.content, stripped: false };
    // frontmatter-only 的文件没有实际规则，不写空段落
    if (!body.trim()) continue;
    const header = `<!-- 由 DSH 编辑器模式从 ${file.rel} 导入。改规则请优先改这里。 -->`
      + (stripped ? '\n<!-- 已忽略原文件的 YAML frontmatter（globs / alwaysApply 是 Cursor 专有语义） -->' : '');
    const section = `${RULE_MARK(file.rel)}\n\n${header}\n\n${body.replace(/\s+$/, '')}\n`;
    next = next ? `${next.replace(/\s+$/, '')}\n\n${section}` : section;
    imported.push(file.rel);
  }

  if (imported.length > 0) fs.writeFileSync(target, next, 'utf8');
  return { imported, skipped, target };
}

/**
 * 把绝对路径转成相对工作区的 POSIX 路径（与编辑器内 `file:line` 的写法一致）。
 *
 * 注意不能只用 `startsWith(folder)`：`/repo-other/a.js` 也以 `/repo` 开头，
 * 会被错算成相对路径 `../repo-other/a.js`。必须要求目录边界。
 */
function toWorkspacePath(fsPath) {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!fsPath) return '';
  const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
  if (folder && (fsPath === folder || fsPath.startsWith(prefix))) {
    return path.relative(folder, fsPath).split(path.sep).join('/');
  }
  return fsPath;
}

/** 把要送进 Agents 输入框的文本格式化：位置行 + 代码块。 */
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

  /**
   * 把旧的 Cursor/Copilot 规则文件导入 AGENTS.md（DSH 原生读它）。
   * 只追加不覆盖，重复执行不会重复写入。
   */
  const importRules = () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (!root) {
      vscode.window.showInformationMessage('没有打开的工作区');
      return;
    }
    let result;
    try {
      result = importLegacyRules(root);
    } catch (err) {
      vscode.window.showWarningMessage(`导入规则失败：${String(err?.message || err)}`);
      return;
    }
    if (result.imported.length === 0 && result.skipped.length === 0) {
      vscode.window.showInformationMessage(
        '没找到旧约定规则文件（.cursorrules / .github/copilot-instructions.md / CODEBUDDY.md）。'
        + 'DSH 会原生读取项目根的 AGENTS.md 与 CLAUDE.md。',
      );
      return;
    }
    if (result.imported.length === 0) {
      vscode.window.showInformationMessage(`这些规则已经导入过了：${result.skipped.join('、')}`);
      return;
    }
    vscode.window.setStatusBarMessage(`已导入 ${result.imported.length} 个规则文件到 AGENTS.md`, 3000);
  };

  /** 右键回调的 uri 取法：优先「全部选中项」，空数组时退回单个 uri。 */
  const pickUris = (uri, uris) => {
    if (Array.isArray(uris) && uris.length > 0) return uris;
    return uri ? [uri] : [];
  };

  /**
   * 把资源管理器里选中的文件/文件夹作为引用发给 DSH Agents。
   *
   * 为什么只送路径不送内容：侧栏 Chat 是真实 Agent 会话，它自己会按路径读文件，
   * 塞进正文既浪费上下文预算，又会让多选时超出单条消息上限。
   *
   * @param {any[]} uris 资源管理器右键时传入的 uri 数组（支持多选）
   * @param {'file'|'folder'} kind 选中的是文件还是目录
   */
  const sendExplorerPaths = (uris, kind) => {
    const list = Array.isArray(uris) ? uris : (uris ? [uris] : []);
    const rels = list
      .map((u) => toWorkspacePath(u?.fsPath || u?.path || ''))
      .filter(Boolean);
    if (rels.length === 0) {
      vscode.window.showInformationMessage('没有选中文件');
      return;
    }
    const head = kind === 'folder'
      ? `请看一下这些目录：\n`
      : (rels.length > 1 ? `请看一下这些文件：\n` : '');
    // 逐项累加，超预算就停下并说明还剩多少：一把梭 join 再让 Host 截断，
    // 会把最后一条路径切成半截。
    const lines = [];
    let used = head.length;
    for (const r of rels) {
      const line = `@${r}`;
      if (used + line.length + 1 > BRIDGE_TEXT_LIMIT) break;
      lines.push(line);
      used += line.length + 1;
    }
    const rest = rels.length - lines.length;
    const tail = rest > 0 ? `…（其余 ${rest} 项未列出）\n` : '';
    const text = `${head}${lines.join('\n')}\n${tail}`;
    if (pushToAgents({ file: rels[0], line: 0, text })) {
      vscode.window.setStatusBarMessage(`已发送 ${rels.length} 项给 DSH Agents`, 2000);
    } else {
      vscode.window.showWarningMessage('DSH Agents 通道未就绪');
    }
  };

  /**
   * 把终端里选中的内容发给 DSH Agents。
   *
   * VS Code 没有公开「读取终端选区」的 API，通行做法是触发
   * `workbench.action.terminal.copySelection` 再读剪贴板。任一环节不可用
   * （命令缺席、剪贴板被禁）都退化成明确提示，不静默失败。
   */
  const sendTerminalSelection = async () => {
    if (!vscode.window.activeTerminal) {
      vscode.window.showInformationMessage('没有活动的终端');
      return;
    }
    const clipboard = vscode.env?.clipboard;
    // 读选区要借剪贴板：先存下用户原本的内容，用完还回去。
    // 不还的话，用户此前复制的东西会被这个命令悄悄覆盖掉。
    let previous = '';
    let previousSaved = false;
    try {
      previous = await clipboard?.readText?.() ?? '';
      previousSaved = true;
    } catch { /* 剪贴板不可读，就不还原 */ }

    let text = '';
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      text = await clipboard?.readText?.() ?? '';
    } catch { /* 命令或剪贴板不可用，下面统一提示 */ } finally {
      if (previousSaved) {
        try { await clipboard?.writeText?.(previous); } catch { /* 还原失败不影响主流程 */ }
      }
    }
    text = String(text || '').trim();
    if (!text) {
      vscode.window.showInformationMessage('终端里没有选中内容');
      return;
    }
    const clipped = text.length > BRIDGE_TEXT_LIMIT
      ? `${text.slice(0, BRIDGE_TEXT_LIMIT)}\n…（已截断）`
      : text;
    const payload = `来自终端的选中内容：\n\`\`\`\n${clipped}\n\`\`\`\n`;
    if (pushToAgents({ file: '', line: 0, text: payload })) {
      vscode.window.setStatusBarMessage('已发送终端选区给 DSH Agents', 2000);
    } else {
      vscode.window.showWarningMessage('DSH Agents 通道未就绪');
    }
  };

  /** 把选区连同「请解释/修改」的引子填进侧栏 Chat 输入框。 */  const askSelection = async () => {
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
    // 「改动前」内容只存在于 DSH 的改动记录里，磁盘上没有；
    // 用虚拟文档承载，供 vscode.diff 作为左侧内容。
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider),
    // diff 关闭后立刻释放对应文本，避免只是靠 DIFF_DOC_MAX 兜底。
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const uri = doc?.uri;
      if (uri && uri.scheme === DIFF_SCHEME) diffDocuments.delete(uri.path);
    }),
    vscode.commands.registerCommand('dshEditorBridge.sendSelection', () => send(true)),
    vscode.commands.registerCommand('dshEditorBridge.sendFile', () => send(false)),
    // 资源管理器 / 终端入口（P1-2）：把选中项作为 @路径 引用送给 Agents
    // 右键可能传 (uri) 或 (uri, 全部选中项)。注意不能用 `uris || [uri]`：
    // 多选回调里 uris 可能是空数组（truthy），会把单选的那个 uri 丢掉。
    vscode.commands.registerCommand('dshEditorBridge.sendExplorerFiles', (uri, uris) => {
      sendExplorerPaths(pickUris(uri, uris), 'file');
    }),
    vscode.commands.registerCommand('dshEditorBridge.sendExplorerFolder', (uri, uris) => {
      sendExplorerPaths(pickUris(uri, uris), 'folder');
    }),
    vscode.commands.registerCommand('dshEditorBridge.sendTerminalSelection', () => {
      void sendTerminalSelection();
    }),
    vscode.commands.registerCommand('dshEditorBridge.importRules', () => importRules()),
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