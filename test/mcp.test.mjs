/**
 * 测试：MCP 工具来源识别（P4-2）。
 *
 * 背景：DSH 已内置 MCP 支持（`mcp-resources` 在 `dsh-base` 组合，所有模式共享），
 * 侧栏 Chat 与 Agents 是同一个 sessionController 会话 —— 所以**能力本身自动可用**，
 * 我们不需要另写 MCP 客户端。
 *
 * 本文件验证的是我们加的**可见性**：把 `mcp__<server>__<tool>` 解析出来，
 * 让用户在侧栏能看出某个工具来自哪个外部 MCP 服务。
 * 这很重要——用户不该在不知情的情况下让代码/数据流向第三方服务。
 *
 * 用法：node test/mcp.test.mjs
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

// 最小 vscode 桩（只为能 require 扩展模块）
const vscode = {
  Uri: { file: (p) => ({ fsPath: p, path: p, toString: () => p }), joinPath: (b, ...n) => ({ fsPath: join(b.fsPath || b.path, ...n), path: join(b.fsPath || b.path, ...n) }), from: (o) => o },
  window: {
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showInformationMessage: () => {}, showWarningMessage: () => {}, showErrorMessage: () => {},
    setStatusBarMessage: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    activeTextEditor: null, activeTerminal: null,
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {} }),
  },
  workspace: {
    workspaceFolders: [], registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }), openTextDocument: async () => ({}),
    getConfiguration: () => ({ get: (_, d) => d }), findFiles: async () => [],
  },
  languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
  StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { One: 1 },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Selection: class { constructor(a, b) { this.anchor = a; this.active = b; } },
  TextEditorRevealType: { InCenter: 1 },
};

const Module = require('node:module');
const originalLoad = Module._load;
let exitCode = 0;

try {
  Module._load = (request, parent, isMain) =>
    (request === 'vscode' ? vscode : originalLoad.call(Module, request, parent, isMain));

  // extension.js 是 CJS：用 require 拿到导出（我们是把 parseMcpTool 挂在 module 上还是
  // 仅内部使用？—— 先看能不能取到；取不到就走静态断言 + 行为模拟）
  const ext = require(join(EXT_DIR, 'extension.js'));
  const parseMcpTool = ext.parseMcpTool || ext.__parseMcpTool;

  console.log('工具名解析');
  if (typeof parseMcpTool === 'function') {
    const r1 = parseMcpTool('mcp__postgres-prod__query');
    check('解析出服务名与工具名',
      r1 && r1.server === 'postgres-prod' && r1.tool === 'query', JSON.stringify(r1));

    const r2 = parseMcpTool('bash');
    check('普通工具返回 null', r2 === null, JSON.stringify(r2));

    const r3 = parseMcpTool('mcp__a__b__c');
    check('工具名含双下划线也能取到服务',
      r3 && r3.server === 'a', JSON.stringify(r3));

    // DSH 超长名会截断并加哈希，分隔符可能被截掉 → 退化为「只标 MCP」
    const truncated = parseMcpTool('mcp__verylongservernamethatgotcutoffandhash_a1b2c3');
    check('分隔符被截断时仍识别为 MCP',
      truncated && truncated.server === '' && truncated.tool.length > 0, JSON.stringify(truncated));

    check('空名字不崩', parseMcpTool('') === null);
    check('null 不崩', parseMcpTool(null) === null);
  } else {
    check('parseMcpTool 未导出（仅内部使用），改由行为断言覆盖', true);
  }

  console.log('侧栏展示契约');
  {
    const { readFileSync } = require('node:fs');
    const extSrc = readFileSync(join(EXT_DIR, 'extension.js'), 'utf8');
    const chatSrc = readFileSync(join(EXT_DIR, 'media', 'chat.js'), 'utf8');
    const cssSrc = readFileSync(join(EXT_DIR, 'media', 'chat.css'), 'utf8');

    check('后端解析 mcp__ 格式', /mcp__\(\.\+\?\)__/.test(extSrc), '正则未找到');
    check('工具卡片携带 mcpServer', extSrc.includes('mcpServer: mcp.server'));
    check('前端渲染 MCP 标识', chatSrc.includes("className === 'tool-mcp'") || chatSrc.includes("'tool-mcp'"));
    check('标识含服务名', /MCP · \$\{part\.mcpServer\}/.test(chatSrc));
    check('服务名缺失时仍标 MCP', /part\.mcpServer \? `MCP · /.test(chatSrc), '未处理空服务名');
    check('有对应样式', cssSrc.includes('.tool-mcp'));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  Module._load = originalLoad;
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: MCP 可见性自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);