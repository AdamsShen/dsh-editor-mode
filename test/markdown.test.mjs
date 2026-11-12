/**
 * 测试：侧栏 Markdown 渲染（media/markdown.js）。
 *
 * 重点覆盖两类真实风险：
 *  1. XSS —— 模型输出里的 HTML/脚本必须被转义，不能进 DOM。
 *  2. 流式未闭合代码块 —— 半截 ```must 不破坏整段渲染。
 *
 * 用法：node test/markdown.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(HERE, '..', 'extensions', 'local.dsh-editor-bridge-0.3.0', 'media', 'markdown.js'),
  'utf8',
);

// markdown.js 是浏览器脚本，只依赖 window。
globalThis.window = {};
new Function(src)();
const { render, escapeHtml } = globalThis.window.DshMarkdown;

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

console.log('escapeHtml');
check('转义尖括号', escapeHtml('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;');
check('转义引号', escapeHtml('a"b\'c') === 'a&quot;b&#39;c');

console.log('XSS');
const evil = '<img src=x onerror="alert(1)">';
check('HTML 标签被转义', !render(evil).includes('<img'), render(evil));
const evilLink = '[click](javascript:alert(1))';
check('javascript: 链接不成为 href', !render(evilLink).includes('href="javascript:'), render(evilLink));

console.log('代码块');
const fenced = render('说明：\n```ts\nconst a = 1 < 2;\n```\n结束');
check('生成 .code 容器', fenced.includes('class="code"'));
check('语言标签', fenced.includes('<span>ts</span>'));
check('代码内容被转义', fenced.includes('const a = 1 &lt; 2;'));
check('复制按钮带编码内容', fenced.includes('data-code="'));
check('未闭合围栏也能渲染成代码块',
  render('```js\nconst a = 1').includes('class="code"'));

console.log('行内与结构');
check('行内代码', render('用 `npm i` 安装').includes('<code>npm i</code>'));
check('粗体', render('**重要**').includes('<strong>重要</strong>'));
check('无序列表', render('- a\n- b').includes('<ul>'));
check('有序列表', render('1. a\n2. b').includes('<ol>'));
check('标题降级（# → h3）', render('# 标题').includes('<h3>标题</h3>'));
check('引用', render('> 引用').includes('<blockquote>引用</blockquote>'));

console.log('边界');
check('空输入不抛错', render('') === '');
check('null 输入不抛错', render(null) === '');
check('纯换行不产生标签', render('\n\n\n') === '');

console.log(failed === 0 ? 'PASS: markdown 渲染全部通过' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);