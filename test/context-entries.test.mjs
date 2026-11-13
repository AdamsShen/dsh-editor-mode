/**
 * 测试：上下文入口（资源管理器 / 终端）的实际行为。
 *
 * 为什么需要：webview-wiring 里只有「菜单声明 ↔ 命令注册」的静态断言，
 * 证明不了命令被调用后到底送出去什么。这里伪造 vscode + 起一个本地 HTTP 服务
 * 冒充 DSH 的 push 通道，捕获 pushToAgents 的真实请求体，验证：
 *   - 单选文件 → 只送一个 @路径
 *   - 多选 → 全部送出（且不丢项）
 *   - 目录 → 走「目录」措辞
 *   - 相对化正确（含 `/repo-other` 不被误判成 `/repo` 内的边界用例）
 *   - 终端：有选区就送代码块；无选区/无终端时给提示且不发请求
 *
 * 全离线（本地 loopback 服务），不连 DSH。
 *
 * 用法：node test/context-entries.test.mjs
 */
import { createServer } from 'node:http';
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

// ------------------------------------------------ 冒充 DSH push 通道
const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { received.push(JSON.parse(body)); } catch { received.push({ raw: body }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// ---------------------------------------------------------------- 伪造 vscode
const providers = {};
const commands = {};
const infos = [];
const warnings = [];
let clipboardText = '';
const clipboardWrites = [];
let activeTerminal = null;
let activeEditor = null;
let terminalSelection = '';

function uriLike(p) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` };
}

const ROOT = '/work/repo';
const vscode = {
  Uri: { file: uriLike, joinPath: (b, ...n) => uriLike(join(b.fsPath || b.path, ...n)), from: uriLike },
  window: {
    registerWebviewViewProvider: (id, p) => { providers[id] = p; return { dispose() {} }; },
    showInformationMessage: (m) => { infos.push(String(m)); },
    showWarningMessage: (m) => { warnings.push(String(m)); },
    showErrorMessage: () => {},
    setStatusBarMessage: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
    get activeTextEditor() { return activeEditor; },
    get activeTerminal() { return activeTerminal; },
  },
  workspace: {
    workspaceFolders: [{ uri: uriLike(ROOT), name: 'repo', index: 0 }],
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
    getConfiguration: () => ({ get: () => undefined }),
  },
  env: {
    clipboard: {
      readText: async () => clipboardText,
      writeText: async (v) => { clipboardText = v; clipboardWrites.push(v); },
    },
  },
  commands: {
    registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; },
    executeCommand: async (cmd) => {
      // 真实世界里 copySelection 会覆盖剪贴板，这里如实模拟
      if (cmd === 'workbench.action.terminal.copySelection') clipboardText = terminalSelection;
    },
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
const originalEnv = {
  BASE: process.env.DSH_EDITOR_BASE,
  TOKEN: process.env.DSH_EDITOR_TOKEN,
  URL: process.env.DSH_BRIDGE_URL,
};

let exitCode = 0;
try {
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };

  process.env.DSH_EDITOR_BASE = `http://127.0.0.1:${port}`;
  process.env.DSH_EDITOR_TOKEN = 'ctx-token';
  process.env.DSH_BRIDGE_URL = `http://127.0.0.1:${port}/push`;

  const extension = require(join(EXT_DIR, 'extension.js'));
  extension.activate({
    extensionUri: uriLike(EXT_DIR),
    subscriptions: [],
    workspaceState: { get() {}, async update() {} },
    globalState: { get() {}, async update() {} },
  });

  check('三个新命令都已注册',
    ['sendExplorerFiles', 'sendExplorerFolder', 'sendTerminalSelection']
      .every((n) => typeof commands[`dshEditorBridge.${n}`] === 'function'));

  /** 触发命令并等 push 到达（pushToAgents 是 fire-and-forget）。 */
  async function trigger(cmd, ...args) {
    received.length = 0;
    infos.length = 0;
    warnings.length = 0;
    await commands[`dshEditorBridge.${cmd}`](...args);
    for (let i = 0; i < 40 && received.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return received[0];
  }

  console.log('单选文件');
  {
    const body = await trigger('sendExplorerFiles', uriLike(`${ROOT}/src/a.js`));
    check('送到了 push 通道', Boolean(body), JSON.stringify(received));
    check('路径相对化', body?.text?.includes('@src/a.js'), body?.text);
    check('带 token', body?.token === 'ctx-token');
    check('单选不加「这些文件」前缀', !String(body?.text || '').includes('这些文件'), body?.text);
  }

  console.log('多选文件');
  {
    const body = await trigger('sendExplorerFiles',
      uriLike(`${ROOT}/src/a.js`),
      [uriLike(`${ROOT}/src/a.js`), uriLike(`${ROOT}/src/b.js`)]);
    const listed = String(body?.text || '').match(/@[^\s]+/g) || [];
    check('两项都送出', listed.length === 2, JSON.stringify(listed));
    check('多选带「这些文件」前缀', String(body?.text || '').includes('这些文件'), body?.text);
  }

  console.log('多选回调给空数组时不丢单选 uri');
  {
    const body = await trigger('sendExplorerFiles', uriLike(`${ROOT}/src/only.js`), []);
    check('空数组回退到单 uri', String(body?.text || '').includes('@src/only.js'), body?.text);
  }

  console.log('目录');
  {
    const body = await trigger('sendExplorerFolder', uriLike(`${ROOT}/src`));
    check('走目录措辞', String(body?.text || '').includes('这些目录'), body?.text);
    check('目录路径相对化', String(body?.text || '').includes('@src'), body?.text);
  }

  console.log('无参数时不发请求并提示');
  {
    received.length = 0;
    infos.length = 0;
    await commands['dshEditorBridge.sendExplorerFiles']();
    await new Promise((r) => setTimeout(r, 80));
    check('无参数不发请求', received.length === 0);
    check('给出没有选中文件的提示', infos.some((m) => m.includes('没有选中文件')), infos.join('|'));
  }

  console.log('工作区边界：/work/repo-other 不能被当成 /work/repo 内');
  {
    const body = await trigger('sendExplorerFiles', uriLike('/work/repo-other/x.js'));
    check('外部路径保持绝对', String(body?.text || '').includes('/work/repo-other/x.js'), body?.text);
    check('没有错误相对化成 ../repo-other', !String(body?.text || '').includes('../repo-other'), body?.text);
  }

  console.log('当前文件入口（collectContext 的路径口径）');
  {
    const editor = (fsPath, text = 'const a = 1;') => ({
      document: {
        uri: uriLike(fsPath),
        languageId: 'javascript',
        getText: () => text,
      },
      selection: { start: { line: 0 }, end: { line: 0 }, isEmpty: true },
    });

    activeEditor = editor(`${ROOT}/src/a.js`);
    let body = await trigger('sendFile');
    check('工作区内文件相对化', String(body?.text || '').includes('@src/a.js'), body?.text);

    // 边界回归：/work/repo-other 不属于 /work/repo
    activeEditor = editor('/work/repo-other/x.js');
    body = await trigger('sendFile');
    check('工作区外文件保持绝对路径',
      String(body?.text || '').includes('/work/repo-other/x.js'), body?.text);
    check('没有被错算成相对路径',
      !String(body?.text || '').includes('@../repo-other'), body?.text);

    activeEditor = null;
    received.length = 0;
    infos.length = 0;
    await commands['dshEditorBridge.sendFile']();
    await new Promise((r) => setTimeout(r, 80));
    check('没有编辑器时不发请求', received.length === 0);
    check('提示没有打开的编辑器', infos.some((m) => m.includes('没有打开的编辑器')), infos.join('|'));
  }

  console.log('终端选区');
  {
    activeTerminal = { name: 'zsh' };
    terminalSelection = 'npm test\n1 passing';
    clipboardText = '用户原本的剪贴板';   // 借完必须还回来
    clipboardWrites.length = 0;
    const body = await trigger('sendTerminalSelection');
    check('送到了 push 通道', Boolean(body), JSON.stringify(received));
    check('内容包在代码块里', String(body?.text || '').includes('```'), body?.text);
    check('带上终端内容', String(body?.text || '').includes('1 passing'), body?.text);
    check('用完还原了用户剪贴板', clipboardText === '用户原本的剪贴板',
      `实际: ${JSON.stringify(clipboardText)}`);
    check('确实执行了还原写回', clipboardWrites.includes('用户原本的剪贴板'), JSON.stringify(clipboardWrites));
  }

  console.log('超长内容：按 Host 的 8000 上限优雅截断，不被中间切断');
  {
    activeTerminal = { name: 'zsh' };
    terminalSelection = 'x'.repeat(20000);
    clipboardText = '原内容3';
    const body = await trigger('sendTerminalSelection');
    const sent = String(body?.text || '');
    check('终端内容不超过 Host 上限', sent.length <= 8000 + 64, `len=${sent.length}`);
    check('给出截断标记', sent.includes('已截断'), sent.slice(-30));
  }

  console.log('海量多选：不切断路径，明确说明剩余项数');
  {
    // 500 项约 6000 字符还没到上限，必须用足以溢出的量才能真正触发截断
    const many = Array.from({ length: 2000 }, (_, i) => uriLike(`${ROOT}/src/f${i}.js`));
    const body = await trigger('sendExplorerFiles', many[0], many);
    const sent = String(body?.text || '');
    check('不超过 Host 上限', sent.length <= 8000 + 64, `len=${sent.length}`);
    check('说明了剩余未列出的项数', /其余 \d+ 项未列出/.test(sent), sent.slice(-40));
    // 不能被从中间切断：每条 @路径 都应当是完整的 .js 文件名
    const paths = sent.match(/@src\/f\d+\.js/g) || [];
    check('列出的每条路径都完整', paths.length > 0 && paths.every((p2) => /^@src\/f\d+\.js$/.test(p2)),
      JSON.stringify(paths.slice(-3)));
    check('没有半截路径', !/@src\/f\d+$/.test(sent.replace(/\n[\s\S]*$/, '')), '末尾项被切开');
  }

  console.log('终端无选区 / 无终端：提示且不发请求');
  {
    activeTerminal = { name: 'zsh' };
    terminalSelection = '   ';
    clipboardText = '原内容2';
    const body = await trigger('sendTerminalSelection');
    check('空选区不发请求', !body, JSON.stringify(received));
    check('给出「没有选中内容」提示', infos.some((m) => m.includes('没有选中内容')), infos.join('|'));
    check('空选区也还原了剪贴板', clipboardText === '原内容2', JSON.stringify(clipboardText));

    activeTerminal = null;
    clipboardText = 'x';
    received.length = 0;
    infos.length = 0;
    await commands['dshEditorBridge.sendTerminalSelection']();
    await new Promise((r) => setTimeout(r, 80));
    check('无终端不发请求', received.length === 0);
    check('给出「没有活动的终端」提示', infos.some((m) => m.includes('没有活动的终端')), infos.join('|'));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  Module._load = originalLoad;
  for (const [k, v] of Object.entries(originalEnv)) {
    const name = k === 'BASE' ? 'DSH_EDITOR_BASE' : k === 'TOKEN' ? 'DSH_EDITOR_TOKEN' : 'DSH_BRIDGE_URL';
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
  await new Promise((resolve) => server.close(resolve));
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: 上下文入口行为自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);