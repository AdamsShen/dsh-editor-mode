/**
 * 测试：Host 侧 /editor-chat 端点（index.js）。
 *
 * 这里不起 code-server，也不连真模型：用假 ctx + 假 llm + 假 req/res 直接
 * 调用注册到 webServer 的 handler，验证真实的 HTTP 行为契约：
 *   - 回环围栏与 token 鉴权（403/401）
 *   - 模型目录读取（复用 agentDefaultModel 的选择）
 *   - SSE 事件序列与内容
 *   - 编辑器上下文确实进了最后一条 user 消息
 *   - 中止：abort 端点能打断上游 signal
 *
 * 用法：node test/host-chat.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, __internals } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

const TOKEN = 'test-token-0123456789';
const tmp = mkdtempSync(join(tmpdir(), 'dsh-editor-chat-'));

/** 采集 llm.stream 收到的参数，并回放一段脚本化流。 */
const llmCalls = [];
let streamScript = [];
function makeLlm() {
  return {
    listProviders: () => [{ id: 'prov-a', name: 'Prov A' }, { id: 'prov-b', name: 'Prov B' }],
    listModels: async (provider) => (
      provider === 'prov-a'
        ? [{ provider, id: 'model-x', name: 'Model X', context: { contextWindow: 128000 } }]
        : [{ provider, id: 'model-y', name: 'Model Y' }]
    ),
    stream: async function* (options) {
      llmCalls.push(options);
      for (const step of streamScript) {
        if (options.signal?.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } };
          return;
        }
        if (typeof step === 'function') { await step(options); continue; }
        yield step;
      }
    },
  };
}

const routes = new Map();
const services = {
  llm: makeLlm(),
  agentDefaultModel: { currentSelection: () => ({ provider: 'prov-a', model: 'model-x' }) },
  webServer: {
    host: '127.0.0.1',
    port: 45678,
    register: (route) => { routes.set(`${route.kind}:${route.path}`, route); return () => {}; },
    registerUpgrade: () => () => {},
  },
};
const ctx = {
  get: (name) => services[name],
  effect: (fn) => { const dispose = fn && fn(); return dispose || (() => {}); },
  logger: { info: () => {}, warn: () => {} },
};

// runtimeDir 指向空目录：boot 会因找不到 code-server 而失败，这是预期的
// （本测试只验证 Chat 端点，不验证进程托管）。
apply(ctx, { runtimeDir: tmp, upstreamPort: 1, bridgeToken: TOKEN });

/** 造一个假 IncomingMessage。 */
function makeReq({ method = 'GET', url = '/', headers = {}, body, ip = '127.0.0.1' }) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: ip },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return req;
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) handler(...args);
    },
  };
  if (body !== undefined) {
    const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    req[Symbol.asyncIterator] = async function* iterator() {
      // 故意切成两块，覆盖流式读取路径
      const half = Math.ceil(buffer.length / 2);
      yield buffer.subarray(0, half);
      yield buffer.subarray(half);
    };
  }
  return req;
}

/** 造一个假 ServerResponse，记录状态、头与写出的字节。 */
function makeRes() {
  const listeners = new Map();
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    writableEnded: false,
    writeHead(code, headers) {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
      return res;
    },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    write(chunk) { res.chunks.push(String(chunk)); return true; },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(String(chunk));
      res.writableEnded = true;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return res;
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) handler(...args);
    },
    text: () => res.chunks.join(''),
  };
  return res;
}

/** 解析 SSE 文本为 [event, payload] 列表。 */
function parseEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length) events.push([event, JSON.parse(data.join('\n'))]);
  }
  return events;
}

// ---------------------------------------------------------------------------

const internals = __internals;

console.log('纯函数：消息组装');
{
  const messages = internals.composeMessages([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在的' },
    { role: 'user', content: '   ' },
  ], 'prov-a', 'model-x');
  check('空消息被丢弃', messages.length === 2, String(messages.length));
  check('user 带 source.kind=user', messages[0].source.kind === 'user');
  check('assistant 带 model 来源',
    messages[1].source.kind === 'model'
    && messages[1].source.provider === 'prov-a'
    && messages[1].source.model === 'model-x');
  check('每条都有唯一 id', messages[0].id !== messages[1].id);
}
{
  const many = Array.from({ length: 60 }, (_v, i) => ({ role: 'user', content: `m${i}` }));
  const messages = internals.composeMessages(many, 'p', 'm');
  check('历史被截到上限', messages.length === internals.CHAT_MAX_MESSAGES, String(messages.length));
  check('保留的是最近的消息', messages.at(-1).content[0].text === 'm59');
}

console.log('纯函数：上下文注入');
{
  const base = internals.composeMessages([{ role: 'user', content: '解释一下' }], 'p', 'm');
  const withCtx = internals.appendContext(base, {
    file: 'src/a.ts', line: 12, text: 'const a = 1;', language: 'typescript', folder: '/repo',
  });
  const text = withCtx.at(-1).content[0].text;
  check('追加了编辑器上下文段', text.includes('【编辑器上下文】'));
  check('带文件与行号', text.includes('src/a.ts:12'));
  check('带语言标注的代码块', text.includes('```typescript'));
  check('原始提问仍在', text.startsWith('解释一下'));
  check('没有新增消息条数', withCtx.length === base.length);
}
{
  const base = internals.composeMessages([{ role: 'user', content: 'x' }], 'p', 'm');
  check('无上下文时原样返回', internals.appendContext(base, null) === base);
  check('空上下文时原样返回', internals.appendContext(base, { file: '', text: '' }) === base);
}

console.log('鉴权与围栏');
{
  const route = routes.get('exact:/editor-chat/models');
  check('models 路由已注册', Boolean(route));

  const res = makeRes();
  await route.handler(makeReq({ url: '/editor-chat/models?token=wrong-token' }), res);
  check('错误 token → 401', res.statusCode === 401, String(res.statusCode));

  const res403 = makeRes();
  await route.handler(makeReq({ url: `/editor-chat/models?token=${TOKEN}`, ip: '10.0.0.5' }), res403);
  check('非回环 → 403', res403.statusCode === 403, String(res403.statusCode));

  const ok = makeRes();
  await route.handler(makeReq({ url: `/editor-chat/models?token=${TOKEN}` }), ok);
  const payload = JSON.parse(ok.text());
  check('正确 token → 200', ok.statusCode === 200);
  check('返回两个 provider', payload.providers.length === 2);
  check('默认模型来自 agentDefaultModel',
    payload.default.provider === 'prov-a' && payload.default.model === 'model-x',
    JSON.stringify(payload.default));
  check('模型带 contextWindow', payload.providers[0].models[0].contextWindow === 128000);
}

console.log('SSE 对话');
{
  streamScript = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你好' },
    { type: 'reasoning-delta', index: 0, text: '先想一想' },
    { type: 'text-delta', index: 0, text: '，世界' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const route = routes.get('exact:/editor-chat/send');
  const res = makeRes();
  await route.handler(makeReq({
    method: 'POST',
    url: '/editor-chat/send',
    body: {
      token: TOKEN,
      requestId: 'r1',
      messages: [{ role: 'user', content: '打个招呼' }],
      context: { file: 'a.ts', line: 3, text: 'const x = 1;', language: 'typescript', folder: '/repo' },
    },
  }), res);

  const events = parseEvents(res.text());
  check('状态码 200', res.statusCode === 200);
  check('content-type 是 SSE',
    String(res.headers['content-type']).includes('text/event-stream'),
    res.headers['content-type']);
  check('首个事件是 meta', events[0][0] === 'meta');
  check('meta 带 requestId', events[0][1].requestId === 'r1');
  check('文本增量拼出完整回答',
    events.filter((e) => e[0] === 'delta').map((e) => e[1].text).join('') === '你好，世界');
  check('思考增量单独出来',
    events.filter((e) => e[0] === 'reasoning').map((e) => e[1].text).join('') === '先想一想');
  check('usage 事件透传', events.some((e) => e[0] === 'usage' && e[1].outputTokens === 3));
  check('finish 事件是 stop',
    events.some((e) => e[0] === 'finish' && e[1].kind === 'stop'));

  const call = llmCalls.at(-1);
  check('使用了 DSH 默认模型', call.provider === 'prov-a' && call.model === 'model-x');
  check('system 里有项目目录', String(call.system).includes('/repo'), String(call.system).slice(0, 120));
  const lastUser = call.messages.at(-1);
  check('上下文注入到最后一条 user 消息',
    lastUser.content[0].text.includes('a.ts:3'));
  check('消息都带 source', call.messages.every((m) => m.source && m.source.kind));
}

console.log('模型显式指定 + 错误处理');
{
  streamScript = [{ type: 'finish', reason: { kind: 'stop' } }];
  const route = routes.get('exact:/editor-chat/send');
  const res = makeRes();
  await route.handler(makeReq({
    method: 'POST',
    url: '/editor-chat/send',
    body: {
      token: TOKEN,
      requestId: 'r2',
      provider: 'prov-b',
      model: 'model-y',
      messages: [{ role: 'user', content: 'hi' }],
    },
  }), res);
  const call = llmCalls.at(-1);
  check('显式模型覆盖默认值', call.provider === 'prov-b' && call.model === 'model-y');
}
{
  // llm 抛错 → 必须变成 error 事件，而不是把连接挂死
  streamScript = [async () => { throw new Error('provider 炸了'); }];
  const route = routes.get('exact:/editor-chat/send');
  const res = makeRes();
  await route.handler(makeReq({
    method: 'POST',
    url: '/editor-chat/send',
    body: { token: TOKEN, requestId: 'r3', messages: [{ role: 'user', content: 'hi' }] },
  }), res);
  const events = parseEvents(res.text());
  check('异常转成 error 事件',
    events.some((e) => e[0] === 'error' && String(e[1].message).includes('provider 炸了')));
  check('响应仍然结束', res.writableEnded === true);
}
{
  const route = routes.get('exact:/editor-chat/send');
  const res = makeRes();
  await route.handler(makeReq({
    method: 'POST',
    url: '/editor-chat/send',
    body: { token: TOKEN, messages: [] },
  }), res);
  check('空对话 → 400', res.statusCode === 400, String(res.statusCode));

  const res401 = makeRes();
  await route.handler(makeReq({
    method: 'POST', url: '/editor-chat/send',
    body: { token: 'wrong', messages: [{ role: 'user', content: 'x' }] },
  }), res401);
  check('错误 token → 401', res401.statusCode === 401);

  const res405 = makeRes();
  await route.handler(makeReq({ method: 'GET', url: '/editor-chat/send' }), res405);
  check('GET → 405', res405.statusCode === 405);
}

console.log('中止');
{
  let sawAbort = false;
  streamScript = [
    { type: 'text-delta', index: 0, text: '开头' },
    async (options) => {
      // 模拟「生成到一半」：等 abort 端点把 signal 置位
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (options.signal?.aborted) { clearInterval(timer); resolve(); }
        }, 5);
        setTimeout(() => { clearInterval(timer); resolve(); }, 1000);
      });
      sawAbort = Boolean(options.signal?.aborted);
    },
  ];
  const sendRoute = routes.get('exact:/editor-chat/send');
  const abortRoute = routes.get('exact:/editor-chat/abort');
  const res = makeRes();
  const pending = sendRoute.handler(makeReq({
    method: 'POST',
    url: '/editor-chat/send',
    body: { token: TOKEN, requestId: 'r-abort', messages: [{ role: 'user', content: '写长文' }] },
  }), res);

  await new Promise((r) => setTimeout(r, 30));
  const abortRes = makeRes();
  await abortRoute.handler(makeReq({
    method: 'POST', url: '/editor-chat/abort',
    body: { token: TOKEN, requestId: 'r-abort' },
  }), abortRes);
  check('abort 端点报告已命中', JSON.parse(abortRes.text()).aborted === true);

  await pending;
  check('上游 signal 被置为 aborted', sawAbort === true);
  check('中止后仍有收尾事件', parseEvents(res.text()).length > 0);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? 'PASS: Host /editor-chat 全部通过' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);