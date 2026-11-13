/**
 * 测试：`@` 引用的选择器行为（P1-1）。
 *
 * `refs.test.mjs` 只覆盖了纯字符串逻辑；选择器本身（怎么列文件、目录、符号，
 * 取消时返回什么）此前只有静态字符串断言。这里用假 vscode 真跑一遍。
 *
 * 覆盖：
 *   - 按 query 过滤文件
 *   - 目录从文件路径反推（不是另扫一遍）
 *   - 符号带 file:line，且只在有 query 时查（空 @ 不打扰语言服务）
 *   - 选中返回 ref，取消返回 null
 *   - 空结果给提示且返回 null
 *   - 排除目录（node_modules 等）确实传给了 findFiles
 *
 * 用法：node test/ref-picker.test.mjs
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
const infos = [];
const ROOT = '/work/repo';

/** 每个用例设置这些钩子。 */
let files = [];
let symbols = [];
let picked = undefined;      // showQuickPick 返回什么；undefined 表示取消
let lastQuickPickItems = [];
let lastFindArgs = null;
let symbolCalls = 0;

function uriLike(p) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` };
}

const vscode = {
  Uri: { file: uriLike, joinPath: (b, ...n) => uriLike(join(b.fsPath || b.path, ...n)), from: uriLike },
  window: {
    registerWebviewViewProvider: (id, p) => { providers[id] = p; return { dispose() {} }; },
    showInformationMessage: (m) => { infos.push(String(m)); },
    showWarningMessage: () => {},
    showErrorMessage: () => {},
    setStatusBarMessage: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    get activeTextEditor() { return null; },
    get activeTerminal() { return null; },
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
    showQuickPick: async (items) => {
      lastQuickPickItems = items;
      return typeof picked === 'function' ? picked(items) : picked;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: uriLike(ROOT), name: 'repo', index: 0 }],
    findFiles: async (include, exclude, max) => {
      lastFindArgs = { include, exclude, max };
      return files.map((f) => uriLike(join(ROOT, f)));
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
    getConfiguration: () => ({ get: () => undefined }),
  },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (cmd) => {
      if (cmd === 'vscode.executeWorkspaceSymbolProvider') { symbolCalls += 1; return symbols; }
      return undefined;
    },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Selection: class { constructor(a, b) { this.anchor = a; this.b = b; } },
  TextEditorRevealType: { InCenter: 1 },
};

const Module = require('node:module');
const originalLoad = Module._load;
let exitCode = 0;

try {
  Module._load = (request, parent, isMain) =>
    (request === 'vscode' ? vscode : originalLoad.call(Module, request, parent, isMain));

  process.env.DSH_EDITOR_BASE = 'http://127.0.0.1:1';
  process.env.DSH_EDITOR_TOKEN = 'picker-token';

  const extension = require(join(EXT_DIR, 'extension.js'));
  extension.activate({
    extensionUri: uriLike(EXT_DIR),
    subscriptions: [],
    workspaceState: { get() {}, async update() {} },
    globalState: { get() {}, async update() {} },
  });

  const provider = providers['dshEditor.chat'];
  check('拿到 provider', Boolean(provider));
  check('有 pickReference', typeof provider?.pickReference === 'function');

  const reset = () => {
    files = []; symbols = []; picked = undefined;
    lastQuickPickItems = []; lastFindArgs = null; symbolCalls = 0;
    infos.length = 0;
  };

  console.log('按 query 过滤文件');
  {
    reset();
    files = ['src/a.js', 'src/b.ts', 'lib/c.js', 'README.md'];
    picked = (items) => items.find((i) => i.ref === 'src/b.ts');
    const ref = await provider.pickReference('b.ts');
    check('返回选中的 ref', ref === 'src/b.ts', String(ref));
    check('只列出匹配项', lastQuickPickItems.length === 1, JSON.stringify(lastQuickPickItems.map((i) => i.ref)));
    check('findFiles 带了排除规则',
      String(lastFindArgs?.exclude || '').includes('node_modules'), JSON.stringify(lastFindArgs?.exclude));
    check('findFiles 设了上限', lastFindArgs?.max === 200, String(lastFindArgs?.max));
  }

  console.log('目录从文件路径反推');
  {
    reset();
    files = ['src/components/Button.tsx', 'src/components/Input.tsx'];
    picked = (items) => items.find((i) => i.kind === 'folder');
    const ref = await provider.pickReference('components');
    check('返回目录 ref', ref === 'src/components', String(ref));
    check('目录项存在', lastQuickPickItems.some((i) => i.kind === 'folder'), JSON.stringify(lastQuickPickItems));
    check('没有重复目录',
      new Set(lastQuickPickItems.map((i) => i.ref)).size === lastQuickPickItems.length,
      JSON.stringify(lastQuickPickItems.map((i) => i.ref)));
  }

  console.log('符号：带 file:line，且只在有 query 时才查');
  {
    reset();
    files = [];
    symbols = [{
      name: 'parseConfig',
      location: { uri: uriLike(join(ROOT, 'src/conf.js')), range: { start: { line: 41 } } },
    }];
    picked = (items) => items.find((i) => i.kind === 'symbol');
    const ref = await provider.pickReference('parseConfig');
    check('符号 ref 是 file:line', ref === 'src/conf.js:42', String(ref));
    check('有 query 时查了符号', symbolCalls === 1, String(symbolCalls));

    reset();
    files = ['src/a.js'];
    picked = null;
    await provider.pickReference('');
    check('空 query 不查符号', symbolCalls === 0, String(symbolCalls));
  }

  console.log('取消与空结果');
  {
    reset();
    files = ['src/a.js'];
    picked = undefined;            // 用户按 Esc
    const ref = await provider.pickReference('a');
    check('取消返回 null', ref === null, String(ref));

    reset();
    files = ['src/a.js'];
    picked = undefined;
    const none = await provider.pickReference('zzz-不存在');
    check('无匹配返回 null', none === null, String(none));
    check('无匹配给提示', infos.some((m) => m.includes('没有匹配')), infos.join('|'));
    check('无匹配时不弹选择器', lastQuickPickItems.length === 0, String(lastQuickPickItems.length));
  }

  console.log('符号缺少位置信息时不崩');
  {
    reset();
    files = [];
    symbols = [{ name: 'anonymous' }, { name: 'ok', location: { uri: uriLike(join(ROOT, 'x.js')), range: { start: { line: 0 } } } }];
    picked = (items) => items.find((i) => i.kind === 'symbol');
    const ref = await provider.pickReference('o');
    check('跳过无位置的符号但不崩', typeof ref === 'string', String(ref));
    check('有位置的符号正常列出', lastQuickPickItems.some((i) => i.ref === 'x.js:1'),
      JSON.stringify(lastQuickPickItems.map((i) => i.ref)));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  Module._load = originalLoad;
  delete process.env.DSH_EDITOR_BASE;
  delete process.env.DSH_EDITOR_TOKEN;
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: @ 引用选择器自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);