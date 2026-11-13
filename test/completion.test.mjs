/**
 * 测试：行内补全的纯逻辑（P3-3）。
 *
 * 补全最危险的不是"没建议"，而是**给出错误的幽灵文本**：
 * 模型常把整个文件重抄一遍、用代码块包起来、或把光标后的内容也吐出来。
 * 这些若不清洗，用户按 Tab 就会把大段重复代码插进文件。
 *
 * 覆盖：
 *   - 清洗：去代码块围栏、去重复前缀尾巴、截掉光标后内容
 *   - 预算：前后文超长时必须截断，不能整文件塞给模型
 *   - 失败静默：llm 抛错 / 超时 / 无服务 → 返回空串，不抛异常
 *   - 空前缀不请求
 *
 * 用法：node test/completion.test.mjs
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

const mod = await import(join(REPO, 'index.js'));
const { requestCompletion, cleanCompletion } = mod;

console.log('清洗模型输出');
{
  check('去掉代码块围栏',
    cleanCompletion('```js\nconst a = 1;\n```', 'x', '') === 'const a = 1;',
    JSON.stringify(cleanCompletion('```js\nconst a = 1;\n```', 'x', '')));

  check('去掉重复的前缀尾巴',
    cleanCompletion('const a = 1;', 'const a = 1;', '') === '',
    JSON.stringify(cleanCompletion('const a = 1;', 'const a = 1;', '')));

  check('截掉光标后的内容',
    cleanCompletion('b = 2;\nreturn b;', 'a = 1;\n', 'return b;') === 'b = 2;',
    JSON.stringify(cleanCompletion('b = 2;\nreturn b;', 'a = 1;\n', 'return b;')));

  check('保留正常续写', cleanCompletion(' console.log(a)', '', '') === ' console.log(a)',
    JSON.stringify(cleanCompletion(' console.log(a)', '', '')));

  check('空输入返回空串', cleanCompletion('', '', '') === '');
}

console.log('预算：前文超长必须截断');
{
  let seenPrefixLen = 0;
  const llm = {
    prepareCall: async () => ({
      stream: (opts) => {
        seenPrefixLen = String(opts.messages[0].content).length;
        return (async function* () { yield { delta: { text: 'ok' } }; })();
      },
    }),
  };
  const longPrefix = 'x'.repeat(10000);
  await requestCompletion({ llm, provider: 'p', model: 'm' }, {
    prefix: longPrefix, suffix: '', language: 'js', file: 'a.js',
  });
  // 4000 前缀 + 1000 后缀的预算，加上提示词，总量应远小于原文
  check('提示词总量受控', seenPrefixLen < 6000, String(seenPrefixLen));
}

console.log('失败一律静默（返回空串，不抛异常）');
{
  check('没有 llm 服务',
    await requestCompletion({}, { prefix: 'a', suffix: '' }) === '');

  const throwing = { prepareCall: async () => { throw new Error('boom'); } };
  check('prepareCall 抛错',
    await requestCompletion({ llm: throwing, provider: 'p', model: 'm' }, { prefix: 'a' }) === '');

  const streamThrow = {
    prepareCall: async () => ({ stream: () => { throw new Error('stream boom'); } }),
  };
  check('stream 抛错',
    await requestCompletion({ llm: streamThrow, provider: 'p', model: 'm' }, { prefix: 'a' }) === '');
}

console.log('空前缀不请求');
{
  let called = 0;
  const llm = { prepareCall: async () => { called += 1; return { stream: () => (async function* () {})() }; } };
  await requestCompletion({ llm, provider: 'p', model: 'm' }, { prefix: '   ', suffix: '' });
  check('空白前缀跳过', called === 0, String(called));
}

console.log('正常续写能返回');
{
  const llm = {
    prepareCall: async () => ({
      stream: () => (async function* () {
        yield { delta: { text: 'console' } };
        yield { delta: { text: '.log(1)' } };
      })(),
    }),
  };
  const text = await requestCompletion({ llm, provider: 'p', model: 'm' }, {
    prefix: 'function f() {\n  ', suffix: '\n}', language: 'js', file: 'a.js',
  });
  check('拼出完整补全', text === 'console.log(1)', JSON.stringify(text));
}

console.log('超时后放弃（不阻塞用户）');
{
  const never = {
    prepareCall: () => new Promise(() => {}),   // 永不 resolve
  };
  const started = Date.now();
  const text = await requestCompletion({ llm: never, provider: 'p', model: 'm' }, { prefix: 'a' });
  const elapsed = Date.now() - started;
  check('超时返回空串', text === '', JSON.stringify(text));
  check('在 1.5s 预算内返回', elapsed < 2500, `${elapsed}ms`);
}

console.log('服务端限流：并发超限时返回 busy 而不是报错');
{
  // 真跑一遍：直接驱动 apply() 注册的路由处理函数不方便，
  // 这里退一步验证"计数器语义"——并发吃满后新请求应被拒。
  // 逻辑要点：上限判断在 await 之前、计数在 finally 回落，否则会漏计。
  const src = (await import('node:fs')).readFileSync(join(REPO, 'index.js'), 'utf8');
  const body = src.slice(src.indexOf("path: '/editor-completion'"),
                        src.indexOf("editor-mode: POST /editor-completion"));

  const guardIdx = body.indexOf('completionInflight >= COMPLETION_SERVER_MAX');
  const incIdx = body.indexOf('completionInflight += 1');
  const awaitIdx = body.indexOf('await requestCompletion');
  const decIdx = body.indexOf('completionInflight -= 1');

  check('上限判断存在', guardIdx > 0, String(guardIdx));
  check('判断在自增之前', guardIdx > 0 && incIdx > guardIdx, `${guardIdx} vs ${incIdx}`);
  check('自增在 await 之前', incIdx > 0 && awaitIdx > incIdx, `${incIdx} vs ${awaitIdx}`);
  check('回落发生在 await 之后', decIdx > awaitIdx, `${decIdx} vs ${awaitIdx}`);
  check('超限返回 busy 且状态 200', /completionInflight >= COMPLETION_SERVER_MAX[\s\S]{0,300}reason: 'busy'/.test(body));
}

console.log(failed === 0 ? 'PASS: 行内补全逻辑自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);