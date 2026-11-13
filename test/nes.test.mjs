/**
 * 测试：下一处编辑预测（P4-3 NES）。
 *
 * NES 是**猜测**，猜错时的代价比不提更高：
 *   - 跳到不存在的行 → 编辑器滚动到文件末尾之外
 *   - 把 "NONE" 当行号 → 跳到第 1 行
 *   - 模型输出自由文本 → 抽不出行号却仍提示
 *
 * 所以重点验证 `parseNextEdit` 的容错与边界，以及整条链路失败时静默。
 *
 * 用法：node test/nes.test.mjs
 */
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

const { parseNextEdit, requestNextEdit } = await import(join(REPO, 'index.js'));

console.log('解析：常见输出形式');
{
  const cases = [
    ['42', 42],
    ['行 42', 42],
    ['`42`', 42],
    ['第 7 行', 7],
    ['src/a.js:88', 88],
    ['  15  \n', 15],
  ];
  for (const [raw, expect] of cases) {
    const r = parseNextEdit(raw, 'a.js', 100);
    check(`「${raw.trim()}」→ 第 ${expect} 行`, r && r.line === expect && r.file === 'a.js',
      JSON.stringify(r));
  }
}

console.log('解析：必须拒绝的情况');
{
  check('NONE 返回 null', parseNextEdit('NONE', 'a.js', 100) === null);
  // 关键：NONE 里若出现数字（模型常写成 "NONE (checked 12 lines)"），
  // 必须先被 NONE 规则挡住，否则会被当成行号——这是 NONE 判断的真正作用
  check('NONE 带数字也不当行号',
    parseNextEdit('NONE (checked 12 lines)', 'a.js', 100) === null,
    JSON.stringify(parseNextEdit('NONE (checked 12 lines)', 'a.js', 100)));
  check('none 小写也返回 null', parseNextEdit('none', 'a.js', 100) === null);
  check('混合文本里的 NONE',
    parseNextEdit('没有需要修改的地方。NONE', 'a.js', 100) === null);

  // 越界是真实危害：会让编辑器跳到文件外
  check('超出总行数被拒', parseNextEdit('999', 'a.js', 100) === null,
    JSON.stringify(parseNextEdit('999', 'a.js', 100)));
  check('第 0 行被拒', parseNextEdit('0', 'a.js', 100) === null);
  check('负数被拒', parseNextEdit('-5', 'a.js', 100) === null);

  check('纯文本无数字返回 null', parseNextEdit('建议重构这个函数', 'a.js', 100) === null);
  check('空输出返回 null', parseNextEdit('', 'a.js', 100) === null);
  check('null 输入不崩', parseNextEdit(null, 'a.js', 100) === null);

  // 总行数未知时不做过界判断（不因此误杀）
  const unknown = parseNextEdit('500', 'a.js', 0);
  check('总行数未知时放行', unknown && unknown.line === 500, JSON.stringify(unknown));
}

console.log('解析：边界上的数字');
{
  const r = parseNextEdit('恰好第 1 行', 'a.js', 100);
  check('第 1 行合法', r && r.line === 1, JSON.stringify(r));

  const last = parseNextEdit('100', 'a.js', 100);
  check('末行合法', last && last.line === 100, JSON.stringify(last));

  const over = parseNextEdit('101', 'a.js', 100);
  check('末行+1 被拒', over === null, JSON.stringify(over));
}

console.log('链路：失败一律静默返回 null');
{
  const noLlm = await requestNextEdit({}, { document: 'const a = 1;' });
  check('没有 llm 服务', noLlm === null);

  const empty = await requestNextEdit(
    { llm: { prepareCall: async () => ({}) }, provider: 'p', model: 'm' },
    { document: '   ' },
  );
  check('空文档不请求', empty === null);

  const throwing = {
    prepareCall: async () => { throw new Error('boom'); },
  };
  const boom = await requestNextEdit({ llm: throwing, provider: 'p', model: 'm' },
    { document: 'const a = 1;' });
  check('prepareCall 抛错返回 null', boom === null);
}

console.log('链路：正常返回');
{
  const llm = {
    prepareCall: async () => ({
      stream: () => (async function* () { yield { delta: { text: '3' } }; })(),
    }),
  };
  const r = await requestNextEdit({ llm, provider: 'p', model: 'm' }, {
    file: 'src/a.js', language: 'javascript', document: 'a\nb\nc\nd\ne',
  });
  check('返回文件与行号', r && r.line === 3 && r.file === 'src/a.js', JSON.stringify(r));
}

console.log('链路：超时不阻塞');
{
  const never = { prepareCall: () => new Promise(() => {}) };
  const started = Date.now();
  const r = await requestNextEdit({ llm: never, provider: 'p', model: 'm' }, { document: 'a' });
  const elapsed = Date.now() - started;
  check('超时返回 null', r === null);
  check('在预算内返回', elapsed < 4000, `${elapsed}ms`);
}

console.log('端点契约：鉴权 / 请求体限制 / 与补全共用并发池');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(REPO, 'index.js'), 'utf8');
  const body = src.slice(src.indexOf("path: '/editor-next-edit'"),
                        src.indexOf("editor-mode: POST /editor-next-edit"));

  check('有鉴权', body.includes('bridgeAllowed(req)'));
  check('限制请求体大小', body.includes('readJsonBody'));
  check('有并发限流', body.includes('completionInflight >= COMPLETION_SERVER_MAX'));
  check('超限返回 next:null 而非报错', /reason: 'busy'/.test(body));
  check('计数在 finally 回落', /finally\s*\{[^}]*completionInflight -= 1/.test(body));

  // 共用池：声明必须在两个 handler 之前，否则读者无法确认可用
  const declIdx = src.indexOf('let completionInflight = 0');
  const nesIdx = src.indexOf("path: '/editor-next-edit'");
  const compIdx = src.indexOf("path: '/editor-completion'");
  check('计数声明在 NES 之前', declIdx > 0 && declIdx < nesIdx, `${declIdx} vs ${nesIdx}`);
  check('计数声明在补全之前', declIdx > 0 && declIdx < compIdx, `${declIdx} vs ${compIdx}`);
}

console.log(failed === 0 ? 'PASS: NES 逻辑自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);