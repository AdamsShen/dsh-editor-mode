/**
 * 测试：旧规则文件导入 AGENTS.md（P1-3）。
 *
 * 背景：DSH 的 `agent-instructions` 模块原生读 `AGENTS.md` / `CLAUDE.md`
 * （含 `.local` 覆盖，按 `.git` 向上找），所以「规则注入」这层平台已经做了。
 * 本功能只补平台读不到的那半边：Cursor / Copilot 的旧约定文件
 * （`.cursorrules`、`.cursor/rules/*.mdc`、`.github/copilot-instructions.md`、
 * `CODEBUDDY.md`）——把它们搬到 AGENTS.md，从 Cursor 迁过来才不会「规则突然失效」。
 *
 * 重点验证：
 *   - 追加而非覆盖（既有 AGENTS.md 内容必须原样保留）
 *   - 带来源标记，重复执行不重复写入（幂等）
 *   - 没有任何旧规则文件时给明确提示、不建空文件
 *   - 四条候选来源都能识别
 *
 * 全离线：用临时目录当假工作区。
 *
 * 用法：node test/rules-import.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

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
const commands = {};
const infos = [];
const warnings = [];
let root = '';

function uriLike(p) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` };
}

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
    get activeTextEditor() { return null; },
    get activeTerminal() { return null; },
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
  },
  workspace: {
    get workspaceFolders() { return root ? [{ uri: uriLike(root), name: 'ws', index: 0 }] : undefined; },
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
    registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; },
    executeCommand: async () => {},
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
const tmpDirs = [];

let exitCode = 0;
try {
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.DSH_EDITOR_BASE = 'http://127.0.0.1:1';
  process.env.DSH_EDITOR_TOKEN = 'rules-token';

  const extension = require(join(EXT_DIR, 'extension.js'));
  extension.activate({
    extensionUri: uriLike(EXT_DIR),
    subscriptions: [],
    workspaceState: { get() {}, async update() {} },
    globalState: { get() {}, async update() {} },
  });

  const importRules = commands['dshEditorBridge.importRules'];
  check('注册了导入命令', typeof importRules === 'function');

  const newRoot = () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'dsh-rules-'));
    tmpDirs.push(dir);
    return dir;
  };

  console.log('没有任何旧规则文件：提示且不创建 AGENTS.md');
  {
    root = newRoot();
    infos.length = 0;
    importRules();
    check('不创建 AGENTS.md', !existsSync(join(root, 'AGENTS.md')));
    check('提示去写 AGENTS.md', infos.some((m) => m.includes('AGENTS.md')), infos.join('|'));
  }

  console.log('四种来源都能识别，并追加进 AGENTS.md');
  {
    root = newRoot();
    writeFileSync(join(root, 'AGENTS.md'), '# 项目约定\n\n- 用中文回答\n');
    writeFileSync(join(root, '.cursorrules'), '始终使用 TypeScript strict\n');
    mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
    writeFileSync(
      join(root, '.cursor', 'rules', 'style.mdc'),
      '---\ndescription: 代码风格\nglobs: ["**/*.ts"]\nalwaysApply: true\n---\n\n缩进两个空格\n',
    );
    // 只有 frontmatter、没有正文的文件不该产生空段落
    writeFileSync(join(root, '.cursor', 'rules', 'empty.mdc'), '---\ndescription: 无正文\n---\n\n');
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'copilot-instructions.md'), '测试必须用 vitest\n');
    writeFileSync(join(root, 'CODEBUDDY.md'), '提交前跑 lint\n');

    infos.length = 0;
    importRules();
    const out = readFileSync(join(root, 'AGENTS.md'), 'utf8');

    check('保留既有内容', out.includes('- 用中文回答'), out.slice(0, 80));
    check('导入 .cursorrules', out.includes('始终使用 TypeScript strict'));
    check('导入 .cursor/rules/*.mdc', out.includes('缩进两个空格'));
    check('导入 copilot-instructions', out.includes('测试必须用 vitest'));
    check('导入 CODEBUDDY.md', out.includes('提交前跑 lint'));
    check('每段带来源标记', (out.match(/<!-- dsh-import: /g) || []).length === 4,
      String((out.match(/<!-- dsh-import: /g) || []).length));
    // 原子写：rename 完成后不应残留临时文件
    check('没有残留临时文件',
      readdirSync(root).every((n) => !n.startsWith('AGENTS.md.tmp-')),
      readdirSync(root).join(','));
    // .mdc 的 Cursor 专有 frontmatter 不能污染 AGENTS.md
    check('剥离了 globs', !out.includes('globs:'), out.split('\n').filter((l) => l.includes('globs')).join('|'));
    check('剥离了 alwaysApply', !out.includes('alwaysApply:'), '');
    check('说明了 frontmatter 被忽略', out.includes('已忽略原文件的 YAML frontmatter'));
    check('正文保留', out.includes('缩进两个空格'));
    check('纯 frontmatter 文件不产生空段落', !out.includes('dsh-import: .cursor/rules/empty.mdc'));
  }

  console.log('重复执行是幂等的');
  {
    const before = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    infos.length = 0;
    importRules();
    const after = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    check('文件内容不变', after === before, `长度 ${before.length} → ${after.length}`);
    check('提示已经导入过', infos.some((m) => m.includes('已经导入过')), infos.join('|'));
  }

  console.log('新增来源只追加新段落');
  {
    writeFileSync(join(root, '.cursorrules'), '始终使用 TypeScript strict\n新增一条：禁止 any\n');
    // 旧段标记已存在，内容更新不会重复写 —— 这是刻意的：避免覆盖用户手改
    const before = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    importRules();
    const after = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    check('已导入的来源不重复追加', after === before, `长度 ${before.length} → ${after.length}`);
  }

  console.log('没有工作区时给提示');
  {
    root = '';
    infos.length = 0;
    importRules();
    check('提示没有打开的工作区', infos.some((m) => m.includes('没有打开的工作区')), infos.join('|'));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  Module._load = originalLoad;
  delete process.env.DSH_EDITOR_BASE;
  delete process.env.DSH_EDITOR_TOKEN;
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: 规则导入自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);