/**
 * 测试：实时路径的「本轮改动」卡片挂载（attachChanges）。
 *
 * 为什么单独一个用例：这条路径从 SSE 事件走到卡片渲染，之前只被静态断言
 * （「源码里有 attachChanges」）覆盖，实际逻辑没验过。而它和折叠路径共用
 * 「卡片挂哪条助手消息」的归属规则 —— 那条规则曾经出错：`workspace/changes`
 * 若晚于 turn/end 到达，会新开一条只有卡片的空气泡，并把后续正文也追进去，
 * 等于把改动算到错误的回合。
 *
 * 用假 vscode + 可控的 fetchChanges 驱动 provider.attachChanges()，
 * 断言四种消息状态下的归属与去重。
 *
 * 全离线：不连 DSH、不碰真实 bridge.json。
 *
 * 用法：node test/attach-changes.test.mjs
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
  Uri: { file: uriLike, joinPath: (b, n) => uriLike(join(b.fsPath || b.path, n)), from: uriLike },
  window: {
    registerWebviewViewProvider: (id, provider) => { providers[id] = provider; return { dispose() {} }; },
    showWarningMessage: () => {},
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    setStatusBarMessage: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  workspace: {
    workspaceFolders: [],
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
    getConfiguration: () => ({ get: () => undefined }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
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

  const sessionView = require(join(EXT_DIR, 'session-view.js'));

  /** 下一次 fetchChanges 的返回。 */
  let nextSummary = null;
  let fetchCount = 0;
  sessionView.fetchChanges = async () => { fetchCount += 1; return nextSummary; };

  process.env.DSH_EDITOR_BASE = 'http://127.0.0.1:1';
  process.env.DSH_EDITOR_TOKEN = 'attach-token';

  const extension = require(join(EXT_DIR, 'extension.js'));
  extension.activate({
    extensionUri: uriLike(EXT_DIR),
    subscriptions: [],
    workspaceState: { get() {}, async update() {} },
    globalState: { get() {}, async update() {} },
  });

  const provider = providers['dshEditor.chat'];
  check('拿到 provider', Boolean(provider));

  const summary = (extra = {}) => ({
    status: 200,
    json: {
      turn: 1, total: 1, added: 2, deleted: 1,
      files: [{ path: '/repo/a/demo.js', display: 'demo.js', added: 2, deleted: 1 }],
      ...extra,
    },
  });

  const cardsOf = (msg) => (msg.parts || []).filter((p) => p.type === 'changes');

  /** 重置成指定的消息状态。 */
  function reset({ streaming = -1, messages = [] } = {}) {
    provider.messages = messages;
    provider.streamingIndex = streaming;
    provider.sessionId = 'session-attach';
    fetchCount = 0;
  }

  console.log('正在流式输出时：挂到当前助手消息');
  {
    reset({
      streaming: 1,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '改文件' }], reasoning: '' },
        { role: 'assistant', parts: [{ type: 'text', text: '改好了' }], reasoning: '' },
      ],
    });
    nextSummary = summary();
    await provider.attachChanges(33);
    check('消息数量不变', provider.messages.length === 2, String(provider.messages.length));
    check('卡片挂在当前助手消息', cardsOf(provider.messages[1]).length === 1);
    check('卡片带 seq', cardsOf(provider.messages[1])[0]?.seq === 33);
    check('卡片带文件列表', (cardsOf(provider.messages[1])[0]?.files || []).length === 1);
  }

  console.log('晚于 turn/end（streamingIndex 已清空）：不得新开空气泡');
  {
    reset({
      streaming: -1,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '改文件' }], reasoning: '' },
        { role: 'assistant', parts: [{ type: 'text', text: '改好了' }], reasoning: '' },
      ],
    });
    nextSummary = summary();
    await provider.attachChanges(34);
    check('没有新增消息', provider.messages.length === 2, String(provider.messages.length));
    check('卡片挂到最近一条助手消息', cardsOf(provider.messages[1]).length === 1);
    check('streamingIndex 未被改写', provider.streamingIndex === -1, String(provider.streamingIndex));
  }

  console.log('下一轮正文不会被追进带卡片的旧消息');
  {
    // 上一步之后 streamingIndex 仍是 -1；模拟新一轮助手开始
    const index = provider.ensureAssistant();
    check('新一轮另起一条助手消息', index === 2, String(index));
    provider.messages[index].parts.push({ type: 'text', text: '下一轮回复' });
    check('旧消息仍只有一张卡片', cardsOf(provider.messages[1]).length === 1);
    check('新消息没有继承卡片', cardsOf(provider.messages[index]).length === 0);
  }

  console.log('同一 seq 不重复挂卡片');
  {
    nextSummary = summary();
    await provider.attachChanges(34);
    check('重复事件不重复出卡', cardsOf(provider.messages[1]).length === 1,
      String(cardsOf(provider.messages[1]).length));
  }

  console.log('拿不到摘要时不建卡片');
  {
    reset({ streaming: 1, messages: [{ role: 'assistant', parts: [], reasoning: '' }] });
    nextSummary = { status: 404, json: { error: '该会话的改动记录已过期' } };
    await provider.attachChanges(35);
    check('404 不出卡', cardsOf(provider.messages[0]).length === 0);

    nextSummary = summary({ files: [] });
    await provider.attachChanges(36);
    check('空文件列表不出卡', cardsOf(provider.messages[0]).length === 0);

    nextSummary = null; // 抛错路径
    sessionView.fetchChanges = async () => { throw new Error('boom'); };
    await provider.attachChanges(37);
    check('异常不出卡且不崩', cardsOf(provider.messages[0]).length === 0);
  }

  console.log('查询期间切换了会话：不得把上一会话的卡片挂到新会话上');
  {
    // 场景 A：只切了 sessionId，消息列表没变 —— 直接验证守卫本身
    // （旧实现在这里会把 session-other 的卡片推进当前助手消息）。
    reset({ streaming: 1, messages: [{ role: 'assistant', parts: [], reasoning: '' }] });
    sessionView.fetchChanges = async () => {
      provider.sessionId = 'session-other';
      return summary();
    };
    await provider.attachChanges(38);
    check('切会话后不往现有消息里塞卡', cardsOf(provider.messages[0]).length === 0,
      JSON.stringify(provider.messages[0]?.parts));
    check('消息数量未变', provider.messages.length === 1, String(provider.messages.length));

    // 场景 B：切会话且消息列表被整体替换 —— 新列表不能被写入
    reset({ streaming: 1, messages: [{ role: 'assistant', parts: [], reasoning: '' }] });
    sessionView.fetchChanges = async () => {
      provider.sessionId = 'session-other';
      provider.messages = [{ role: 'user', parts: [{ type: 'text', text: '新会话' }], reasoning: '' }];
      return summary();
    };
    await provider.attachChanges(39);
    check('新会话的消息没有被写入旧卡', cardsOf(provider.messages[0]).length === 0,
      JSON.stringify(provider.messages[0]?.parts));

    // 复位，避免影响后续用例
    sessionView.fetchChanges = async () => { fetchCount += 1; return nextSummary; };
  }

  console.log('重连快照：折叠出的 pending 卡片必须被补全');
  {
    reset({ streaming: -1, messages: [] });
    // fetchChanges 走可控返回：补全时必须被调到
    sessionView.fetchChanges = async () => {
      fetchCount += 1;
      return summary({ fileOverride: undefined });
    };
    const snapshotEvents = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改文件' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '改好了' }] } } },
      { seq: 33, type: 'workspace/changes', data: { turn: 1 } },
      { seq: 34, type: 'turn/end', data: { turn: 1 } },
    ];
    // 直接驱动 onStreamEvent 的 snapshot 分支（等价于重连收到开篇帧）
    // 签名是 (sessionId, event, data)，且会丢弃非当前会话的帧
    provider.onStreamEvent(provider.sessionId, 'snapshot', { events: snapshotEvents });
    // 等补全完成
    for (let i = 0; i < 10 && provider.messages.flatMap((m) => m.parts || [])
      .some((p) => p.type === 'changes' && p.pending); i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const card = provider.messages.flatMap((m) => m.parts || []).find((p) => p.type === 'changes');
    check('快照里出现改动卡片', Boolean(card));
    check('卡片已被补全（不再 pending）', card && card.pending !== true, JSON.stringify(card && card.pending));
    check('卡片带上文件列表', Boolean(card && (card.files || []).length === 1),
      JSON.stringify(card && (card.files || []).length));
    check('确实发起了补全请求', fetchCount > 0, String(fetchCount));
  }

  console.log('非法 seq 直接返回');
  {
    reset({ streaming: 0, messages: [{ role: 'assistant', parts: [], reasoning: '' }] });
    fetchCount = 0;
    await provider.attachChanges(NaN);
    await provider.attachChanges(-1);
    check('非法 seq 不发请求', fetchCount === 0, String(fetchCount));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  Module._load = originalLoad;
  if (originalBase === undefined) delete process.env.DSH_EDITOR_BASE;
  else process.env.DSH_EDITOR_BASE = originalBase;
  if (originalToken === undefined) delete process.env.DSH_EDITOR_TOKEN;
  else process.env.DSH_EDITOR_TOKEN = originalToken;
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: 实时改动卡片归属自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);