/**
 * 联调测试（真实 DSH + 真实模型，需在本机 DSH 运行时执行）：
 *   node test/integration-chat.live.mjs
 *
 * 做法：伪造 `vscode` 模块后加载扩展本体，连**真实**的 DSH `/editor-sessions/*`
 * 端点，走完整链路：
 *   假 webview → 扩展 Node 侧 → HTTP → DSH Host → sessionController → 真模型
 *   → follow() SSE（snapshot / session-event / assistant-chunk）→ 扩展状态机
 *   → postMessage 回 webview
 *
 * 2026-11 协议变更：侧栏 Chat 不再是独立纯模型对话，而是 DSH 真实 Agent 会话的
 * 第二个视图。旧用例断言的 `models` / `delta` / `message.content` 全部消失，
 * 改为 `sessionId` / parts 模型 / `append` 增量。本文件已按新协议重写。
 *
 * 与 test/*.test.mjs 的区别：那些是离线单元测试；这个是端到端联调，
 * 依赖 DSH 正在运行，因此不进 run-all，按需手动跑。
 *
 * 跳过条件：找不到 bridge.json，或 DSH 端点不可达。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, '..', 'extensions', 'local.dsh-editor-bridge-0.3.0');
const require = createRequire(import.meta.url);

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

// ---------------------------------------------------------------- 取通道
let bridge;
try {
  bridge = JSON.parse(readFileSync(join(os.homedir(), '.dsh', 'editor-runtime', 'bridge.json'), 'utf8'));
} catch {
  console.log('SKIP: 没有 bridge.json（DSH 编辑器模式未加载）');
  process.exit(0);
}
process.env.DSH_EDITOR_BASE = bridge.base;
process.env.DSH_EDITOR_TOKEN = bridge.token;

try {
  // 新协议下「通道是否就绪」用会话列表探活（旧代码探的是已删除的 /editor-chat/models）
  const res = await fetch(`${bridge.base}/editor-sessions/list?token=${bridge.token}`, {
    headers: { 'x-dsh-editor-token': bridge.token },
  });
  if (res.status !== 200) throw new Error(`status ${res.status}`);
} catch (err) {
  console.log(`SKIP: DSH 端点不可达（${err.message}）`);
  process.exit(0);
}

// ---------------------------------------------------------------- 伪造 vscode
const posted = [];
const messageHandlers = [];
const providers = {};
const commands = {};

function uriLike(fsPath) {
  return {
    fsPath,
    path: fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath}`,
  };
}

const vscode = {
  Uri: {
    file: (p) => uriLike(p),
    joinPath: (base, ...parts) => uriLike(join(base.fsPath || base.path, ...parts)),
    from: (o) => uriLike(o.path),
  },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Selection: class { constructor(a, b) { this.start = a; this.end = b; this.anchor = a; this.active = b; this.isEmpty = false; } },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  TextEditorRevealType: { InCenter: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  window: {
    activeTextEditor: {
      document: {
        uri: uriLike(join(EXT_DIR, 'package.json')),
        languageId: 'json',
        getText: () => '{\n  "name": "demo"\n}',
      },
      selection: { start: { line: 1 }, end: { line: 2 }, isEmpty: false },
    },
    registerWebviewViewProvider: (id, provider) => {
      providers[id] = provider;
      return { dispose() {} };
    },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    showInformationMessage: () => {},
    showWarningMessage: () => {},
    showErrorMessage: () => {},
    setStatusBarMessage: () => ({ dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: uriLike(EXT_DIR), name: 'ext', index: 0 }],
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
    getConfiguration: () => ({ get: () => undefined }),
  },
  commands: {
    registerCommand: (id, fn) => {
      commands[id] = fn;
      return { dispose() {} };
    },
    executeCommand: async () => {},
  },
};

// 让扩展里的 require('vscode') 拿到桩
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require(join(EXT_DIR, 'extension.js'));

// ---------------------------------------------------------------- 跑起来
const context = {
  extensionUri: uriLike(EXT_DIR),
  subscriptions: [],
  workspaceState: {
    store: {},
    get(key) { return this.store[key]; },
    async update(key, value) { this.store[key] = value; },
  },
};

console.log('激活');
extension.activate(context);
check('注册了 Chat 视图 provider', Boolean(providers['dshEditor.chat']));
check('注册了命令', Object.keys(commands).length >= 4, Object.keys(commands).join(','));

const view = {
  visible: true,
  viewType: 'dshEditor.chat',
  webview: {
    cspSource: 'vscode-resource:',
    options: {},
    html: '',
    asWebviewUri: (u) => ({ toString: () => `vscode-resource:${u.fsPath || u.path}` }),
    onDidReceiveMessage: (handler) => { messageHandlers.push(handler); return { dispose() {} }; },
    postMessage: async (message) => { posted.push(message); return true; },
  },
  onDidChangeVisibility: () => ({ dispose() {} }),
  onDidDispose: () => ({ dispose() {} }),
};

const chatProvider = providers['dshEditor.chat'];
if (!chatProvider) {
  // 激活没注册视图时直接失败退出：否则下一行会抛 TypeError，看不出根因
  console.log('  ✗ 激活未注册 Chat 视图 provider，后续断言无意义');
  process.exit(1);
}
chatProvider.resolveWebviewView(view, {}, {});
check('注入了 webview html', view.webview.html.includes('<!doctype html>'));
check('html 里没有未替换的占位符', !/\{\{\w+\}\}/.test(view.webview.html),
  (view.webview.html.match(/\{\{\w+\}\}/g) || []).join(','));
check('html 引用了 markdown.js 与 chat.js',
  view.webview.html.includes('markdown.js') && view.webview.html.includes('chat.js'));

const receive = (message) => messageHandlers.forEach((handler) => handler(message));

/** 等待某个条件成立（扩展对 webview 消息是 fire-and-forget，只能轮询状态）。 */
async function waitFor(predicate, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const lastState = () => posted.filter((m) => m.type === 'state').at(-1);

console.log('会话列表与自动建会话');
receive({ type: 'ready' });
await waitFor(() => Array.isArray(posted.filter((m) => m.type === 'sessions').at(-1)?.items));
check('推送了会话列表', Boolean(posted.filter((m) => m.type === 'sessions').at(-1)));

// 发一句话会驱动扩展 ensureSession()（没有会话时先建一个）
console.log('真实调用模型（走 DSH 会话）');
posted.length = 0;
const started = Date.now();
receive({ type: 'send', text: '只回复四个字：链路已通' });

const created = await waitFor(() => Boolean(lastState()?.sessionId));
check('自动创建了会话', created, JSON.stringify(lastState())?.slice(0, 160));

const settled = await waitFor(() => {
  const state = lastState();
  return Boolean(state?.sessionId && state.busy === false && (state.messages || []).length > 0);
});
const elapsed = Date.now() - started;
check('生成收敛到 busy=false', settled, '等待超时');

const finalState = lastState();
const textOf = (message) => (message?.parts || [])
  .filter((p) => p.type === 'text')
  .map((p) => p.text)
  .join('');

const userMessages = (finalState?.messages || []).filter((m) => m.role === 'user');
const assistantMessages = (finalState?.messages || []).filter((m) => m.role === 'assistant');
const assistantText = assistantMessages.map(textOf).join('\n');

check('用户消息已入列', userMessages.some((m) => textOf(m).includes('链路已通')),
  JSON.stringify(userMessages).slice(0, 160));
check('助手回复非空', assistantText.trim().length > 0, JSON.stringify(assistantMessages)?.slice(0, 200));
check('回答里含预期内容', assistantText.includes('链路已通'), assistantText.slice(0, 120));
check('没有残留错误', !finalState?.error, finalState?.error);
check(`端到端耗时 < 120s（实际 ${elapsed}ms）`, elapsed < 120000);

console.log('会话标题');
const titled = await waitFor(() => Boolean(lastState()?.sessionTitle), 30000);
check('会话拿到标题（DSH 自动生成）', titled, lastState()?.sessionTitle || '(空)');

console.log('安全');
const serialized = JSON.stringify(posted);
check('webview 消息里没有 token', !serialized.includes(bridge.token));
check('webview 消息里没有 base URL', !serialized.includes(bridge.base));

console.log('新建会话');
receive({ type: 'newChat' });
await waitFor(() => {
  const state = lastState();
  return Boolean(state?.sessionId && state.sessionId !== finalState?.sessionId);
}, 30000);
const afterNew = lastState();
// 只断言「不同」不够：建会话失败时 sessionId 会是空串，'' !== 旧 id 同样成立，
// 会变成一个永远通过的假阳性。要求「非空且不同」。
check('新建后拿到新的会话 id',
  Boolean(afterNew?.sessionId) && afterNew.sessionId !== finalState?.sessionId,
  `${finalState?.sessionId} → ${JSON.stringify(afterNew?.sessionId)}`);
check('新建后消息为空', (afterNew?.messages || []).length === 0,
  String((afterNew?.messages || []).length));

console.log('上下文提示');
receive({ type: 'ready' });
await new Promise((resolve) => setTimeout(resolve, 300));
const withCtx = lastState();
check('state 带上下文摘要', typeof withCtx?.contextLabel === 'string' && withCtx.contextLabel.length > 0,
  withCtx?.contextLabel);

// 还原全局钩子
Module._load = originalLoad;

console.log(failed === 0 ? 'PASS: 扩展 ↔ DSH ↔ 模型 端到端联调通过' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);
