/**
 * 测试：AI 改动的前后对比（openChangeDiff）。
 *
 * 为什么需要：这条链路把「DSH 的 hunks」翻译成「原生 vscode.diff 能吃的两份文档」，
 * 中间有三个容易悄悄错的地方，而且错了用户看不出来：
 *   1. 反推的「改动前」内容对不对（错了就是假 diff）
 *   2. 文件在该轮之后被改过时，会不会硬拼出误导性的对比
 *   3. 虚拟文档的内存有没有回收（长会话会一直涨）
 *
 * 做法：伪造 `vscode` + 替换 `sessionView.fetchChangeDiff` + 拦截 `fs.readFileSync`，
 * 然后直接调 provider.openChangeDiff()，检查：
 *   - 调了 vscode.diff，且两侧内容正是期望的 before / after
 *   - 漂移 / 二进制 / 记录过期时**不打开** diff，并给出提示
 *   - 虚拟文档超过上限会被淘汰、关闭时会释放
 *
 * 全离线：不连 DSH、不碰真实 bridge.json。
 *
 * 用法：node test/change-diff.test.mjs
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
const diffCommands = [];
const warnings = [];
const infos = [];
let contentProvider = null;
let diffShouldThrow = false;
let closeHandler = null;

function uriLike(p) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` };
}

const vscode = {
  Uri: {
    file: uriLike,
    joinPath: (base, name) => uriLike(join(base.fsPath || base.path, name)),
    from: (o) => ({ scheme: o.scheme, path: o.path, query: o.query || '', fsPath: o.path, toString: () => `${o.scheme}:${o.path}` }),
  },
  window: {
    registerWebviewViewProvider: (id, provider) => { providers[id] = provider; return { dispose() {} }; },
    showWarningMessage: (msg) => { warnings.push(String(msg)); },
    showInformationMessage: (msg) => { infos.push(String(msg)); },
    showErrorMessage: (msg) => { warnings.push(String(msg)); },
    setStatusBarMessage: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (cmd, left, right, title) => {
      if (cmd !== 'vscode.diff') return;
      if (diffShouldThrow) throw new Error('command unavailable');
      diffCommands.push({ left, right, title });
    },
  },
  workspace: {
    workspaceFolders: [],
    registerTextDocumentContentProvider: (_scheme, p) => { contentProvider = p; return { dispose() {} }; },
    onDidCloseTextDocument: (fn) => { closeHandler = fn; return { dispose() {} }; },
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
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
const fs = require('node:fs');
const realReadFileSync = fs.readFileSync;
const originalBase = process.env.DSH_EDITOR_BASE;
const originalToken = process.env.DSH_EDITOR_TOKEN;

/** 假磁盘：只有 demo.txt 有内容，其余按原实现走。 */
const DEMO = '/tmp/dsh-diff-test/demo.txt';
let demoContent = 'line1\nchanged-line\nline3\n';

let exitCode = 0;
try {
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  fs.readFileSync = (p, ...rest) => {
    if (String(p) === DEMO) return demoContent;
    return realReadFileSync.call(fs, p, ...rest);
  };

  const sessionView = require(join(EXT_DIR, 'session-view.js'));

  /** 下一次 fetchChangeDiff 的返回；由用例逐次设置。 */
  let nextDiff = null;
  sessionView.fetchChangeDiff = async () => nextDiff;

  process.env.DSH_EDITOR_BASE = 'http://127.0.0.1:1';
  process.env.DSH_EDITOR_TOKEN = 'diff-token';

  const extension = require(join(EXT_DIR, 'extension.js'));
  extension.activate({
    extensionUri: uriLike(EXT_DIR),
    subscriptions: [],
    workspaceState: { get() {}, async update() {} },
    globalState: { get() {}, async update() {} },
  });

  const provider = providers['dshEditor.chat'];
  check('拿到 provider', Boolean(provider));
  check('注册了虚拟文档 provider', Boolean(contentProvider));
  check('注册了关闭释放钩子', Boolean(closeHandler));

  // uri 为空时返回空串：断言失败要给出清晰信息，而不是抛 TypeError
  const readDoc = (uri) => (uri ? contentProvider.provideTextDocumentContent(uri) : '');
  const okDiff = (over = {}) => ({
    kind: 'text',
    path: DEMO,
    display: 'demo.txt',
    before: true,
    after: true,
    coarse: false,
    hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' line1', '-line2', '+changed-line', ' line3'] }],
    ...over,
  });

  console.log('正常对比：反推的 before 必须正确');
  {
    nextDiff = { status: 200, json: okDiff() };
    diffCommands.length = 0;
    await provider.openChangeDiff('s1', 33, 0);

    check('打开了 vscode.diff', diffCommands.length === 1, String(diffCommands.length));
    const cmd = diffCommands[0] || {};
    check('标题带文件名', String(cmd.title || '').includes('demo.txt'), String(cmd.title));
    check('before 内容正确', readDoc(cmd.left) === 'line1\nline2\nline3\n',
      JSON.stringify(readDoc(cmd.left)));
    check('after 用磁盘原文（含末尾换行）', readDoc(cmd.right) === demoContent,
      JSON.stringify(readDoc(cmd.right)));
    check('没有误报警告', warnings.length === 0, warnings.join(' | '));
  }

  console.log('CRLF 文件：\r 必须保留，不能被误判漂移');
  {
    demoContent = 'a\r\nB\r\nc\r\n';
    nextDiff = {
      status: 200,
      json: okDiff({
        hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a\r', '-b\r', '+B\r', ' c\r'] }],
      }),
    };
    diffCommands.length = 0;
    await provider.openChangeDiff('s1', 34, 0);
    check('CRLF 也打开了 diff', diffCommands.length === 1, String(diffCommands.length));
    const cmd = diffCommands[0] || {};
    check('CRLF before 保留 \\r', readDoc(cmd.left) === 'a\r\nb\r\nc\r\n',
      JSON.stringify(readDoc(cmd.left)));
    demoContent = 'line1\nchanged-line\nline3\n';
  }

  console.log('文件末尾没有换行：hunk 里的 no-newline 标记不得当成内容行');
  {
    // DSH 的 hunks 来自 jsdiff 的 structuredPatch：末尾缺换行时会在 lines 里
    // 插一行 `\ No newline at end of file`。它既不是旧侧内容，也不计入 newLines。
    demoContent = 'line1\nchanged-line';
    nextDiff = {
      status: 200,
      json: okDiff({
        hunks: [{
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [' line1', '-line2', '+changed-line', '\\ No newline at end of file'],
        }],
      }),
    };
    diffCommands.length = 0;
    warnings.length = 0;
    await provider.openChangeDiff('s1', 36, 0);
    check('末尾无换行也打开了 diff', diffCommands.length === 1, String(diffCommands.length));
    check('没有误报「之后又被修改」', warnings.length === 0, warnings.join(' | '));
    const cmd = diffCommands[0] || {};
    check('before 反推正确且不含标记行', readDoc(cmd.left) === 'line1\nline2',
      JSON.stringify(readDoc(cmd.left)));
    check('after 保持无末尾换行', readDoc(cmd.right) === 'line1\nchanged-line',
      JSON.stringify(readDoc(cmd.right)));
    demoContent = 'line1\nchanged-line\nline3\n';
  }

  console.log('文件在该轮之后又被改过：必须拒绝，不能拼假 diff');
  {
    demoContent = 'line1\nNEWER-EDIT\nline3\n';
    nextDiff = { status: 200, json: okDiff() };
    diffCommands.length = 0;
    warnings.length = 0;
    await provider.openChangeDiff('s1', 35, 0);
    check('没有打开 diff', diffCommands.length === 0, String(diffCommands.length));
    check('给出了「之后又被修改」提示',
      warnings.some((w) => w.includes('之后又被修改')), warnings.join(' | '));
    demoContent = 'line1\nchanged-line\nline3\n';
  }

  console.log('二进制 / 过大 / 过期：明确提示且不打开');
  {
    for (const [kind, expect] of [['binary', '二进制'], ['oversized', '过大']]) {
      nextDiff = { status: 200, json: { kind, path: DEMO, display: 'demo.txt' } };
      diffCommands.length = 0;
      infos.length = 0;
      await provider.openChangeDiff('s1', 36, 0);
      check(`${kind} 不打开 diff`, diffCommands.length === 0);
      check(`${kind} 给出提示`, infos.some((m) => m.includes(expect)), infos.join(' | '));
    }

    nextDiff = { status: 404, json: { error: '该改动的记录已过期' } };
    diffCommands.length = 0;
    warnings.length = 0;
    await provider.openChangeDiff('s1', 37, 0);
    check('404 不打开 diff', diffCommands.length === 0);
    check('404 提示已过期', warnings.some((w) => w.includes('过期')), warnings.join(' | '));

    nextDiff = { status: 503, json: { error: 'DSH 未提供改动对比服务' } };
    warnings.length = 0;
    await provider.openChangeDiff('s1', 38, 0);
    check('503 提示服务缺失', warnings.some((w) => w.includes('改动对比服务')), warnings.join(' | '));
  }

  console.log('非法入参直接返回，不发请求也不打开');
  {
    let called = 0;
    const realFetch = sessionView.fetchChangeDiff;
    sessionView.fetchChangeDiff = async () => { called += 1; return { status: 200, json: okDiff() }; };
    diffCommands.length = 0;
    await provider.openChangeDiff('', 39, 0);
    await provider.openChangeDiff('s1', NaN, 0);
    await provider.openChangeDiff('s1', 39, NaN);
    check('非法入参不发请求', called === 0, String(called));
    check('非法入参不打开 diff', diffCommands.length === 0);
    sessionView.fetchChangeDiff = realFetch;
  }

  console.log('vscode.diff 不可用时给提示，不产生未处理拒绝');
  {
    nextDiff = { status: 200, json: okDiff() };
    demoContent = 'line1\nchanged-line\nline3\n';
    diffShouldThrow = true;
    diffCommands.length = 0;
    warnings.length = 0;
    await provider.openChangeDiff('s1', 50, 0);
    diffShouldThrow = false;
    check('命令抛错时不崩', true);
    check('给出了无法打开的提示',
      warnings.some((w) => w.includes('无法打开对比')), warnings.join(' | '));
  }

  console.log('虚拟文档内存有界，关闭即释放');
  {
    nextDiff = { status: 200, json: okDiff() };
    // 上限 32 份；连开 20 次（40 份）→ 最早的应被淘汰
    for (let i = 0; i < 20; i += 1) await provider.openChangeDiff('s1', 40 + i, 0);
    const oldest = { scheme: 'dsh-changes', path: '/before/1-0' };
    check('最旧的虚拟文档已被淘汰', readDoc(oldest) === '', JSON.stringify(readDoc(oldest)));

    const latest = diffCommands[diffCommands.length - 1];
    check('最新的仍可读', readDoc(latest.left).length > 0);

    // 关闭文档 → 内容释放
    const victim = latest.left;
    closeHandler({ uri: victim });
    check('关闭后内容被释放', readDoc(victim) === '', JSON.stringify(readDoc(victim)));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  fs.readFileSync = realReadFileSync;
  Module._load = originalLoad;
  if (originalBase === undefined) delete process.env.DSH_EDITOR_BASE;
  else process.env.DSH_EDITOR_BASE = originalBase;
  if (originalToken === undefined) delete process.env.DSH_EDITOR_TOKEN;
  else process.env.DSH_EDITOR_TOKEN = originalToken;
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: 改动对比链路自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);