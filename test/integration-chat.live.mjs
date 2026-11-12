/**
 * 联调测试（真实 DSH + 真实模型，需在本机 DSH 运行时执行）：
 *   node test/integration-chat.live.mjs
 *
 * 做法：伪造 `vscode` 模块后加载扩展本体，连**真实**的 DSH /editor-chat 端点，
 * 走完整链路：
 *   假 webview → 扩展 Node 侧 → HTTP → DSH Host → ctx.llm → 真模型流式返回
 *   → SSE 解析 → 扩展状态机 → postMessage 回 webview
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
const EXT_DIR = join(HERE, '..', 'extensions', 'local.dsh-editor-bridge-0.2.0');
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
  const res = await fetch(`${bridge.base}/editor-chat/models?token=${bridge.token}`);
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
  },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Selection: class { constructor(a, b) { this.start = a; this.end = b; this.anchor = a; this.active = b; this.isEmpty = false; } },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  TextEditorRevealType: { InCenter: 2 },
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
    setStatusBarMessage: () => {},
    showTextDocument: async () => ({ selection: null, revealRange: () => {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: uriLike(EXT_DIR) }],
    openTextDocument: async () => ({}),
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

providers['dshEditor.chat'].resolveWebviewView(view, {}, {});
check('注入了 webview html', view.webview.html.includes('<!doctype html>'));
check('html 里没有未替换的占位符', !/\{\{\w+\}\}/.test(view.webview.html),
  (view.webview.html.match(/\{\{\w+\}\}/g) || []).join(','));
check('html 引用了 markdown.js 与 chat.js',
  view.webview.html.includes('markdown.js') && view.webview.html.includes('chat.js'));

const receive = (message) => messageHandlers.forEach((handler) => handler(message));

/** 等待某个条件成立（扩展对 webview 消息是 fire-and-forget，只能轮询状态）。 */
async function waitFor(predicate, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

console.log('拉模型列表 + 首屏状态');
receive({ type: 'ready' });
await new Promise((resolve) => setTimeout(resolve, 600));
const firstState = posted.filter((m) => m.type === 'state').at(-1);
check('推送了 state', Boolean(firstState));
check('模型列表非空', Boolean(firstState?.models?.providers?.length),
  JSON.stringify(firstState?.models)?.slice(0, 120));
check('默认模型来自 DSH', Boolean(firstState?.provider && firstState?.model),
  `${firstState?.provider}/${firstState?.model}`);
check('带上下文默认开启', firstState?.contextEnabled === true);

console.log(`真实调用模型：${firstState?.provider}/${firstState?.model}`);
posted.length = 0;
const started = Date.now();
receive({ type: 'send', text: '只回复四个字：链路已通' });
// 扩展对 webview 消息不返回 Promise（VS Code 的通知式 API），只能等状态收敛。
const settled = await waitFor(() => {
  const last = posted.filter((m) => m.type === 'state').at(-1);
  return Boolean(last && last.busy === false);
});
const elapsed = Date.now() - started;
check('生成有收敛到 busy=false', settled, '等待超时');

const deltas = posted.filter((m) => m.type === 'delta').map((m) => m.text).join('');
const finalState = posted.filter((m) => m.type === 'state').at(-1);
const lastAssistant = (finalState?.messages || []).filter((m) => m.role === 'assistant').at(-1);

check('收到流式增量', deltas.length > 0, `deltas=${JSON.stringify(deltas)}`);
check('模型回答非空', Boolean(lastAssistant?.content?.trim()),
  JSON.stringify(lastAssistant)?.slice(0, 160));
check('回答里含预期内容', String(lastAssistant?.content || '').includes('链路已通'),
  lastAssistant?.content);
check('生成结束后 busy 归位', finalState?.busy === false);
check('没有残留错误', !finalState?.error, finalState?.error);
check('user 消息已入列',
  (finalState?.messages || []).some((m) => m.role === 'user' && m.content.includes('链路已通')));
check(`端到端耗时 < 90s（实际 ${elapsed}ms）`, elapsed < 90000);

console.log('多轮与持久化');
check('workspaceState 落盘了对话',
  Array.isArray(context.workspaceState.store['dshEditor.chat.v1']?.messages)
  && context.workspaceState.store['dshEditor.chat.v1'].messages.length >= 2,
  JSON.stringify(context.workspaceState.store['dshEditor.chat.v1'])?.slice(0, 160));
check('落盘不含占位消息',
  !(context.workspaceState.store['dshEditor.chat.v1']?.messages || []).some((m) => m.pending));

console.log('安全');
const serialized = JSON.stringify(posted);
check('webview 消息里没有 token', !serialized.includes(bridge.token));
check('webview 消息里没有 base URL', !serialized.includes(bridge.base));

console.log('新对话');
receive({ type: 'newChat' });
await new Promise((resolve) => setTimeout(resolve, 100));
const cleared = posted.filter((m) => m.type === 'state').at(-1);
check('新对话清空消息', (cleared?.messages || []).length === 0);
check('新对话保留模型选择', cleared?.provider === finalState?.provider);

console.log('上下文提示');
receive({ type: 'ready' });
await new Promise((resolve) => setTimeout(resolve, 100));
const withCtx = posted.filter((m) => m.type === 'state').at(-1);
check('state 带上下文摘要', typeof withCtx?.contextLabel === 'string' && withCtx.contextLabel.length > 0,
  withCtx?.contextLabel);

console.log(failed === 0 ? 'PASS: 扩展 ↔ DSH ↔ 模型 端到端联调通过' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);