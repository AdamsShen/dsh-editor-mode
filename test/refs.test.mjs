/**
 * 测试：`@` 引用的纯逻辑（P1-1）。
 *
 * 实现只有一处：`media/chat.js` 里的内联副本（webview 不能 require）。
 * 早先还有一份 `refs.js` 供扩展侧复用，但扩展实际不需要它——它是 ESM，
 * 在旧 Node 扩展宿主上 require 会 ERR_REQUIRE_ESM，最终变成「只为测试存在的
 * 死代码 + 两份会漂移的实现」。已删除，改为直接从 chat.js 抽取被测代码。
 *
 * 抽取方式：把 chat.js 里那一段自包含源码取出，用 Function 求值拿到函数。
 * 这样测的就是**线上真正跑的那份代码**，而不是它的副本。
 *
 * 用法：node test/refs.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(here, '..', 'extensions', 'local.dsh-editor-bridge-0.3.0');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ✓', name);
  else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

console.log('实现只有一处（防止再长出会漂移的副本）');
{
  check('refs.js 已删除', !existsSync(join(EXT_DIR, 'refs.js')));
  const extensionSrc = readFileSync(join(EXT_DIR, 'extension.js'), 'utf8');
  check('扩展侧没有 require refs', !/require\(['"]\.\/refs/.test(extensionSrc));
  const chatSrc = readFileSync(join(EXT_DIR, 'media', 'chat.js'), 'utf8');
  check('chat.js 里有实现', chatSrc.includes('function refTokenAt(') && chatSrc.includes('function applyRef('));
}

// ---------------------------------------------------------------- 抽取被测代码
const chatSrc = readFileSync(join(EXT_DIR, 'media', 'chat.js'), 'utf8');
const start = chatSrc.indexOf('  const REF_CHAR = ');
const end = chatSrc.indexOf('  /** 输入 `@` 后请求扩展弹选择器');
check('找到实现片段', start > 0 && end > start, `${start}..${end}`);

const snippet = chatSrc.slice(start, end).split('\n').map((l) => l.replace(/^  /, '')).join('\n');
const { refTokenAt, applyRef } = new Function(`${snippet}\nreturn { refTokenAt, applyRef };`)();

console.log('识别光标处的 @token');
{
  const cases = [
    ['@', 1, { start: 0, query: '' }],
    ['@src', 4, { start: 0, query: 'src' }],
    ['看下 @src/a.js', 13, { start: 3, query: 'src/a.js' }],
    ['@a @b', 5, { start: 3, query: 'b' }],
    ['@文档/说明.md', 9, { start: 0, query: '文档/说明.md' }],
    ['@src#func', 9, { start: 0, query: 'src#func' }],
  ];
  for (const [text, cursor, expect] of cases) {
    const got = refTokenAt(text, cursor);
    check(`「${text}」@${cursor}`,
      got && got.start === expect.start && got.query === expect.query, JSON.stringify(got));
  }
}

console.log('不该被当成引用的情形');
{
  check('邮箱不被识别', refTokenAt('a@b.com', 7) === null, JSON.stringify(refTokenAt('a@b.com', 7)));
  check('无 @ 返回 null', refTokenAt('plain text', 10) === null);
  check('空格后无 token', refTokenAt('hello @ ', 8) === null, JSON.stringify(refTokenAt('hello @ ', 8)));
  // 光标夹紧到 0 时它位于 @ 之前，尚未开始输入引用 → null
  check('负数光标夹紧到开头', refTokenAt('@a', -5) === null, JSON.stringify(refTokenAt('@a', -5)));
  check('超长光标被夹紧', refTokenAt('@a', 999)?.query === 'a', JSON.stringify(refTokenAt('@a', 999)));
}

console.log('替换引用');
{
  const r1 = applyRef('@sr', 3, 'src/a.js');
  check('替换未完成的 token', r1.value === '@src/a.js ', JSON.stringify(r1.value));
  check('光标落在引用之后', r1.cursor === 10, String(r1.cursor));

  const r2 = applyRef('@src tail', 3, 'src/a.js');
  check('光标在中间时替换整个 token', r2.value === '@src/a.js  tail', JSON.stringify(r2.value));

  const r3 = applyRef('看下 @ab 谢谢', 6, 'src/a.js');
  check('保留前后文', r3.value === '看下 @src/a.js  谢谢', JSON.stringify(r3.value));

  const r4 = applyRef('', 0, 'src/a.js');
  check('空输入直接插入', r4.value === '@src/a.js ', JSON.stringify(r4.value));

  const r5 = applyRef('前文', 2, 'src/a.js');
  check('无 token 时补空格再插入', r5.value === '前文 @src/a.js ', JSON.stringify(r5.value));

  const r6 = applyRef('@x', 2, 'has space/file.md');
  check('路径含空格时加引号', r6.value === '@"has space/file.md" ', JSON.stringify(r6.value));

  const r7 = applyRef('@x', 2, '@already/prefixed.js');
  check('ref 自带 @ 时不重复', r7.value === '@already/prefixed.js ', JSON.stringify(r7.value));
}

console.log(failed === 0 ? 'PASS: @ 引用逻辑自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);