/**
 * 测试：本地代码检索（P4-1）。
 *
 * 清单明确要求「先做本地关键词版」，且验收标准里有一条硬要求：
 * **不把用户代码传到第三方**。所以这里除了功能，重点验证安全边界：
 *
 *   - 只搜 root 内（rg 的 cwd 就是 root，不接受任意路径参数）
 *   - 固定参数、不经 shell（spawn 传数组）→ 无命令注入面
 *   - 用户输入是**字面量**而非正则：搜 `foo(` 不该报错
 *   - 结果条数有上限，超长单行被截断
 *   - `.gitignore` 里的文件被跳过（rg 默认行为，确认没被我们破坏）
 *
 * 真跑 rg（不 mock），因为要验证的正是「rg 参数用对了没有」。
 *
 * 用法：node test/search.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ✓', name);
  else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

const { searchCode, confineRoot } = await import(join(REPO, 'index.js'));

const tmpDirs = [];
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-search-'));
  tmpDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'function parseConfig() {}\nconst x = parseConfig();\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const parseConfigHelper = 1;\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'function parseConfig() {}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nignored.js\n');
  writeFileSync(join(root, 'ignored.js'), 'const parseConfig = 2;\n');
  // 超长单行：用来验证截断
  writeFileSync(join(root, 'src', 'long.js'), `const parseConfig = ${'x'.repeat(500)};\n`);
  return root;
}

let exitCode = 0;
try {
  const root = makeTree();

  console.log('root 必须限定在工作区内（安全边界）');
  {
    const ws = '/work/repo';
    check('工作区本身允许', confineRoot(ws, ws).root === ws, JSON.stringify(confineRoot(ws, ws)));
    check('子目录允许', confineRoot('/work/repo/src', ws).root === '/work/repo/src');
    check('空 root 回落到工作区', confineRoot('', ws).root === ws);

    // 前缀相似但不是子目录 —— 必须拒绝
    const sibling = confineRoot('/work/repo-other', ws);
    check('兄弟目录被拒', !sibling.root && sibling.error === 'root-outside-workspace',
      JSON.stringify(sibling));

    const home = confineRoot('/Users/someone', ws);
    check('家目录被拒', !home.root, JSON.stringify(home));

    const rootDir = confineRoot('/', ws);
    check('根目录被拒', !rootDir.root, JSON.stringify(rootDir));

    check('无工作区时拒绝', !confineRoot('/x', '').root);
  }

  console.log('基本检索');
  {
    const r = await searchCode({ root, pattern: 'parseConfig' });
    check('有结果', r.lines.length > 0, JSON.stringify(r));
    check('带文件路径与行号',
      r.lines.every((l) => l.path && Number.isInteger(l.line) && l.line > 0),
      JSON.stringify(r.lines[0]));
    check('命中多个文件', new Set(r.lines.map((l) => l.path)).size >= 2,
      JSON.stringify([...new Set(r.lines.map((l) => l.path))]));
  }

  console.log('安全边界：不搜依赖目录与 gitignore 内容');
  {
    const r = await searchCode({ root, pattern: 'parseConfig' });
    const paths = r.lines.map((l) => l.path);
    check('跳过 node_modules', !paths.some((p) => p.includes('node_modules')), JSON.stringify(paths));
    check('跳过 .gitignore 里的文件', !paths.some((p) => p.includes('ignored.js')), JSON.stringify(paths));
  }

  console.log('没有 .gitignore 的仓库：仍要排除依赖目录');
  {
    // 真实项目里存在没有 .gitignore 的仓库（或 .gitignore 没写 node_modules）。
    // 此时显式 --glob 排除是唯一防线，不能依赖 ignore 文件。
    const bare = mkdtempSync(join(tmpdir(), 'dsh-search-bare-'));
    tmpDirs.push(bare);
    mkdirSync(join(bare, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(bare, 'src'), { recursive: true });
    writeFileSync(join(bare, 'node_modules', 'dep', 'i.js'), 'const needle = 1;\n');
    writeFileSync(join(bare, 'src', 'k.js'), 'const needle = 2;\n');

    const r = await searchCode({ root: bare, pattern: 'needle' });
    const paths = r.lines.map((l) => l.path);
    check('没有 .gitignore 也跳过 node_modules',
      !paths.some((p2) => p2.includes('node_modules')), JSON.stringify(paths));
    check('正常文件仍能搜到', paths.some((p2) => p2.includes('src/k.js')), JSON.stringify(paths));
  }

  console.log('用户输入按字面量处理（不是正则）');
  {
    const r = await searchCode({ root, pattern: '(' });
    check('括号不会让 rg 报错', !r.error, JSON.stringify(r.error));
    const r2 = await searchCode({ root, pattern: 'function parseConfig()' });
    check('含括号的完整片段能搜到', r2.lines.length > 0, JSON.stringify(r2));
  }

  console.log('上限与截断');
  {
    const r = await searchCode({ root, pattern: 'parseConfig', maxResults: 1 });
    check('结果被限制', r.lines.length <= 1, String(r.lines.length));
    check('标记了截断', r.truncated === true, JSON.stringify(r.truncated));

    const big = await searchCode({ root, pattern: 'xxxxxxxx' });
    const longLine = big.lines.find((l) => l.path.includes('long.js'));
    check('超长行被截断', longLine && longLine.text.length <= 260, String(longLine?.text?.length));
  }

  console.log('无匹配与非法输入');
  {
    const r = await searchCode({ root, pattern: 'zzz-not-exist-zzz' });
    check('无匹配返回空且不报错', r.lines.length === 0 && !r.error, JSON.stringify(r));

    const empty = await searchCode({ root, pattern: '   ' });
    check('空 pattern 直接返回', empty.lines.length === 0);

    const tooLong = await searchCode({ root, pattern: 'x'.repeat(500) });
    check('超长 pattern 被拒', tooLong.error === 'pattern-too-long', JSON.stringify(tooLong.error));

    const noRoot = await searchCode({ pattern: 'a' });
    check('缺 root 返回空', noRoot.lines.length === 0);
  }

  console.log('glob 过滤');
  {
    const r = await searchCode({ root, pattern: 'parseConfig', glob: '*.ts' });
    check('只搜 ts 文件', r.lines.length > 0 && r.lines.every((l) => l.path.endsWith('.ts')),
      JSON.stringify(r.lines.map((l) => l.path)));
  }
} catch (err) {
  failed += 1;
  console.log('  ✗ 用例抛错', err && err.stack ? err.stack : String(err));
} finally {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

exitCode = failed ? 1 : 0;
console.log(failed === 0 ? 'PASS: 本地检索自洽' : `FAIL: ${failed} 项失败`);
process.exit(exitCode);