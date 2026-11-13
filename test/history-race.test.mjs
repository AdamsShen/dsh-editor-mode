/**
 * 测试：历史加载的并发代号（historyGen）。
 *
 * 为什么单独一个用例：这是纯时序问题，静态断言和假 DOM 用例都覆盖不到
 * （它们要么不加载扩展，要么不涉及 HTTP 时序）。而它是个真实缺陷：
 * 快速切 tab 或「视图刚显示又刷新」时，先发的慢请求后到，会把新会话的历史
 * 覆盖成旧会话的 —— 表现是「切过去看到的是上一个会话的内容」。
 *
 * 做法：
 *   1. 伪造 `vscode` 模块（复用 integration 测试的 Module._load 手法）
 *   2. 在 require 扩展之前把 `sessionView.request` 换成**手动回应**的假实现
 *   3. activate() 拿到 provider，驱动 loadHistory() 两次，由测试**显式决定**
 *      先回哪个、后回哪个
 *   4. 断言最终 messages 来自最新一次加载
 *
 * 为什么不用 setTimeout 控制时序：那样「旧的后到」就依赖机器负载了 ——
 * 繁忙时旧请求可能反而先回，于是变异代码也能通过，测试会静默失效。
 * 手动回应让危险顺序由构造保证，与本机快慢无关。
 *
 * 全离线：不连 DSH、不碰真实 bridge.json（通道用 env 注入）。
 *
 * 用法：node test/history-race.test.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(here, '..', 'extensions', 'local.dsh-editor-bridge-0.3.0');
const require = createRequire(import.meta.url);

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ✓', name);
  else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

// ---------------------------------------------------------------- 伪造 vscode
const providers = {};

function uriLike(p) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` };
}

const vscode = {
  Uri: { file: uriLike, joinPath: (base, name) => uriLike(join(base.fsPath || base.path, name)), from: uriLike },
  window: {
    registerWebviewViewProvider: (id, provider) => {
      providers[id] = provider;
      return { dispose() {} };
    },
    showWarningMessage: () => {},
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async () => {},
  },
  workspace: {
    workspaceFolders: [],
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
    getConfiguration: () => ({ get: () => undefined }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  Position: class { constructor(line, ch) { this.line = line; this.character = ch; } },
  Selection: class { constructor(a, b) { this.anchor = a; this.active = b; } },
  TextEditorRevealType: { InCenter: 1 },
};

const Module = require('node:module');
const originalLoad = Module._load;
const originalBase = process.env.DSH_EDITOR_BASE;
const originalToken = process.env.DSH_EDITOR_TOKEN;

let exitCode = 0;
try {
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };

  // --------------------------------------------- 先替换数据层的请求实现
  // 必须在 require 扩展**之前**替换：扩展在 require 时就把 session-view 的
  // 导出对象存进了闭包，之后调 `sessionView.request` 查的是同一个对象。
  const sessionView = require(join(EXT_DIR, 'session-view.js'));

  /** 每次请求按顺序取一项；回应时机由测试显式控制。 */
  let plan = [];
  /** 已发起但尚未回应的请求，按发起顺序排列。 */
  const queue = [];
  const requestLog = [];

  function queueRequest(_channel, _method, pathname) {
    requestLog.push(pathname);
    const entry = plan.shift();
    if (!entry) return Promise.resolve({ status: 404, json: null, text: '' });
    return new Promise((resolve) => {
      queue.push({ resolve, entry });
    });
  }
  sessionView.request = queueRequest;

  /** 回应第 index 个待回请求，并让 await 链推进一轮。 */
  async function respond(index) {
    const item = queue.splice(index, 1)[0];
    if (!item) throw new Error(`没有第 ${index} 个待回请求（当前 ${queue.length} 个）`);
    item.resolve({
      status: 200,
      json: { events: item.entry.events, cursor: null, hasMore: false },
      text: '',
    });
    await new Promise((r) => setTimeout(r, 0));
  }

  // 补全改动卡片的请求不参与本用例，直接给「已过期」
  sessionView.fetchChanges = async () => ({ status: 404, json: null, text: '' });

  // -------------------------------------------------------------- 激活扩展
  process.env.DSH_EDITOR_BASE = 'http://127.0.0.1:1';
  process.env.DSH_EDITOR_TOKEN = 'race-token';

  const extension = require(join(EXT_DIR, 'extension.js'));
  const context = {
    extensionUri: uriLike(EXT_DIR),
    subscriptions: [],
    workspaceState: { get() {}, async update() {} },
    globalState: { get() {}, async update() {} },
  };
  extension.activate(context);

  const provider = providers['dshEditor.chat'];
  check('拿到 Chat 视图 provider', Boolean(provider));

  /** 造一段带标记的历史事件，便于断言「最终留下的是哪一次」。 */
  function eventsWithUserText(text) {
    return [{
      seq: 1,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    }];
  }

  function firstUserText(messages) {
    for (const msg of messages || []) {
      if (msg.role !== 'user') continue;
      for (const part of msg.parts || []) {
        if (part.type === 'text' && part.text) return part.text;
      }
    }
    return '';
  }

  console.log('并发加载：旧响应不得覆盖新列表');
  {
    provider.sessionId = 'session-race';
    plan = [
      { events: eventsWithUserText('旧会话内容') },
      { events: eventsWithUserText('新会话内容') },
    ];
    const oldLoad = provider.loadHistory();   // queue[0] = 旧
    const newLoad = provider.loadHistory();   // queue[1] = 新
    check('两次加载都已发出', queue.length === 2, String(queue.length));

    // 危险顺序：新的先回，旧的后回（若无代号守卫，旧会覆盖新）
    await respond(1);
    await respond(0);
    await Promise.all([oldLoad, newLoad]);

    check('最终留下的是新会话内容', firstUserText(provider.messages) === '新会话内容',
      firstUserText(provider.messages));
    check('旧会话内容没有回写', !JSON.stringify(provider.messages || []).includes('旧会话内容'));
  }

  console.log('单次加载仍然正常（代号不误伤）');
  {
    provider.sessionId = 'session-race';
    plan = [{ events: eventsWithUserText('唯一内容') }];
    const one = provider.loadHistory();
    await respond(0);
    await one;
    check('单次加载生效', firstUserText(provider.messages) === '唯一内容', firstUserText(provider.messages));
  }

  console.log('加载失败不覆盖已有内容');
  {
    provider.sessionId = 'session-race';
    const before = firstUserText(provider.messages);
    sessionView.request = () => Promise.resolve({ status: 500, json: { error: 'boom' }, text: '' });
    await provider.loadHistory();
    check('失败后保留上一次成功的内容', firstUserText(provider.messages) === before,
      `${before} vs ${firstUserText(provider.messages)}`);
  }

  console.log('过期补全不再回写（避免新列表卡片停在读取中）');
  {
    // 这一段的时序：第一代落地后开始补全改动卡片（挂起）→ 第二代落地并补全完成
    // → 第一代的补全此时才回来。它作用在**已被替换**的对象上，若还去 postState，
    // 就会把当前列表重画一次（新卡片可能仍处于 pending）。守卫要求它直接放弃。
    provider.sessionId = 'session-race';
    // 上一块把 request 换成了固定 500 的桩，这里装回队列版
    sessionView.request = queueRequest;
    const fetchQueue = [];
    sessionView.fetchChanges = () => new Promise((resolve) => { fetchQueue.push(resolve); });

    const changesEvent = (seq) => ({
      seq, type: 'workspace/changes', data: { turn: 1 },
    });
    plan = [
      { events: [{
        seq: 1, type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一代' }] },
      }, changesEvent(11)] },
      { events: [{
        seq: 2, type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二代' }] },
      }, changesEvent(22)] },
    ];

    let posts = 0;
    const realPost = provider.postState.bind(provider);
    provider.postState = () => { posts += 1; realPost(); };

    const first = provider.loadHistory();
    await respond(0);                       // 第一代落地 → 补全发出（挂起）
    await new Promise((r) => setTimeout(r, 0));
    check('第一代发出了补全请求', fetchQueue.length === 1, String(fetchQueue.length));

    const second = provider.loadHistory();
    await respond(0);                       // 第二代落地 → 补全发出（挂起）
    await new Promise((r) => setTimeout(r, 0));
    check('第二代也发出了补全请求', fetchQueue.length === 2, String(fetchQueue.length));

    fetchQueue[1]({ status: 404, json: null, text: '' }); // 新的先完成
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all([first, second]);

    const postsBefore = posts;
    fetchQueue[0]({ status: 404, json: null, text: '' }); // 旧的迟到
    await new Promise((r) => setTimeout(r, 0));

    check('过期的补全不再触发渲染', posts === postsBefore, `多渲染了 ${posts - postsBefore} 次`);
    provider.postState = realPost;
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  // 无论成败都还原全局钩子与环境，避免影响同进程后续代码
  Module._load = originalLoad;
  if (originalBase === undefined) delete process.env.DSH_EDITOR_BASE;
  else process.env.DSH_EDITOR_BASE = originalBase;
  if (originalToken === undefined) delete process.env.DSH_EDITOR_TOKEN;
  else process.env.DSH_EDITOR_TOKEN = originalToken;
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: 历史加载并发安全' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);