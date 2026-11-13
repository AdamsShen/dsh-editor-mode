/**
 * 测试：编辑器侧栏 Chat 的会话桥（sessions.js）。
 *
 * 设计变更（2026-11）：编辑器里的 Chat 不再是独立纯模型对话，而是 DSH 真实
 * Agent 会话的第二个视图（双模式 X）。因此旧 /editor-chat/* 整体删除，
 * 改为 /editor-sessions/* 搬运 sessionController。
 *
 * 本用例用假 sessionController + 假 webServer 验证真实契约：
 *   - 回环围栏与 token 鉴权
 *   - list / search / create / prompt / cancel / rename 的请求收敛
 *   - follow() 的三类帧如何映射成 SSE（snapshot / session-event / assistant-chunk）
 *   - sessionController 缺失时返回 503 而不是静默失败
 *
 * 用法：node test/session-bridge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSessionRoutes } from '../sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

const TOKEN = 'bridge-token-xyz';

// ---- 假 DSH 服务 ----
const calls = [];
function makeController(overrides = {}) {
  return {
    list: async (_req, signal) => {
      calls.push(['list', signal?.aborted === false ? 'live' : 'nosignal']);
      return {
        items: [
          { sessionId: 's1', updatedAt: 3000, running: true, blank: false, cwd: '/repo/a', projections: { values: { title: '修复登录' } } },
          { sessionId: 's2', updatedAt: 2000, running: false, blank: true, cwd: '/repo/b', projections: { values: { title: null } } },
        ],
      };
    },
    search: async (req) => {
      calls.push(['search', req.query]);
      return { items: [{ sessionId: 's1', cwd: '/repo/a', updatedAt: 3000, snippet: '...登录...' }], nextCursor: null };
    },
    create: async (req) => { calls.push(['create', req]); return { sessionId: 'new-1', agentPreset: 'default' }; },
    prompt: async (req) => { calls.push(['prompt', req]); return { accepted: true }; },
    cancel: async (req) => { calls.push(['cancel', req]); return {}; },
    rename: async (req) => { calls.push(['rename', req]); return {}; },
    page: async (req) => {
      calls.push(['page', req]);
      // 真实形状：{cursor, records:[{type:'event', event}], hasMore}
      return { cursor: 3, records: [{ type: 'event', event: { seq: 1, type: 'turn/start' } }], hasMore: false };
    },
    async *follow(req, signal) {
      calls.push(['follow', req.address?.sessionId]);
      yield { type: 'snapshot', header: { id: 's1', cwd: '/repo/a' }, records: [{ type: 'event', event: { seq: 1, type: 'turn/start' } }], hasMore: false, cursor: 1 };
      yield { type: 'event', event: { seq: 2, type: 'tool/call', data: { name: 'read_file' } } };
      yield { type: 'assistant-stream', frame: { type: 'start', startedAfterSeq: 1 } };
      yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '正在' } } };
      yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '执行' } } };
      yield { type: 'weird-future-frame' };
      void signal;
    },
    ...overrides,
  };
}

// ---- 假 HTTP 设施 ----
const routes = new Map();
const webServer = {
  register: (route) => { routes.set(`${route.kind}:${route.path}`, route); return () => {}; },
};

function makeReq({ method = 'GET', url = '/', headers = {}, body, ip = '127.0.0.1' }) {
  const listeners = new Map();
  const req = {
    method, url, headers, socket: { remoteAddress: ip },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return req;
    },
    emit(event, ...args) { for (const h of listeners.get(event) || []) h(...args); },
  };
  if (body !== undefined) {
    const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    req[Symbol.asyncIterator] = async function* () {
      const half = Math.ceil(buffer.length / 2);
      yield buffer.subarray(0, half);
      yield buffer.subarray(half);
    };
  }
  return req;
}

function makeRes() {
  const listeners = new Map();
  const res = {
    statusCode: 200, headers: {}, chunks: [], writableEnded: false,
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(c) { this.chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); this.writableEnded = true; },
    on(e, h) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(h); return this; },
    emit(e, ...a) { for (const h of listeners.get(e) || []) h(...a); },
    text() { return this.chunks.join(''); },
  };
  return res;
}

function parseEvents(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length) out.push([event, JSON.parse(data.join('\n'))]);
  }
  return out;
}

// ---- 装配 ----
let services = { sessionController: makeController() };
const ctx = { get: (n) => services[n] };

registerSessionRoutes({
  ctx, webServer, token: TOKEN,
  deps: {
    loopbackOnly: (req) => req.socket.remoteAddress === '127.0.0.1',
    tokenFromRequest: (req, url) => req.headers['x-dsh-editor-token'] || url.searchParams.get('token') || '',
    readJsonBody: async (req, limit) => {
      const parts = [];
      for await (const c of req) parts.push(c);
      const buf = Buffer.concat(parts);
      if (buf.length > limit) return { tooLarge: true };
      try { return { value: JSON.parse(buf.toString('utf8')) }; } catch { return { invalid: true }; }
    },
    sseWriter: (res) => {
      let closed = false;
      res.on('close', () => { closed = true; });
      return {
        write(event, data) { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
        get closed() { return closed; },
      };
    },
  },
});

const call = (path, opts) => routes.get(`exact:${path}`).handler(makeReq(opts), opts.__res ?? makeRes());
const run = async (path, opts) => { const res = makeRes(); await routes.get(`exact:${path}`).handler(makeReq(opts), res); return res; };

// ---- 用例 ----
console.log('鉴权与围栏');
{
  const r = await run('/editor-sessions/list', { url: '/editor-sessions/list?token=wrong' });
  check('错误 token → 401', r.statusCode === 401, String(r.statusCode));
  const r2 = await run('/editor-sessions/list', { url: `/editor-sessions/list?token=${TOKEN}`, ip: '10.1.2.3' });
  check('非回环 → 403', r2.statusCode === 403, String(r2.statusCode));
  const r3 = await run('/editor-sessions/list', { method: 'POST', url: '/editor-sessions/list' });
  check('方法不符 → 405', r3.statusCode === 405, String(r3.statusCode));
}

console.log('列表：全部工作区');
{
  const r = await run('/editor-sessions/list', { url: `/editor-sessions/list?token=${TOKEN}` });
  const body = JSON.parse(r.text());
  check('200', r.statusCode === 200);
  check('跨工作区返回 2 条', body.items.length === 2, String(body.items.length));
  check('标题从 title 投影取出', body.items[0].title === '修复登录', JSON.stringify(body.items[0]));
  check('无标题时为空串（前端用 cwd 兜底）', body.items[1].title === '', JSON.stringify(body.items[1]));
  check('保留 cwd / updatedAt / running', body.items[0].cwd === '/repo/a' && body.items[0].updatedAt === 3000 && body.items[0].running === true);
  check('不泄漏内部 projections', !('projections' in body.items[0]));
}

console.log('搜索');
{
  const r = await run('/editor-sessions/search', { url: `/editor-sessions/search?q=${encodeURIComponent('登录')}&token=${TOKEN}` });
  const body = JSON.parse(r.text());
  check('把 query 传给 DSH', calls.some(([n, v]) => n === 'search' && v === '登录'));
  check('返回命中项', body.items.length === 1 && body.items[0].id === 's1');
  const empty = await run('/editor-sessions/search', { url: `/editor-sessions/search?token=${TOKEN}` });
  check('空 query 不调 DSH 直接返回空', JSON.parse(empty.text()).items.length === 0);
}

console.log('新建 / 发送 / 取消 / 重命名');
{
  const r = await run('/editor-sessions/create', { method: 'POST', url: '/editor-sessions/create', body: { token: TOKEN, cwd: '/repo/a' } });
  check('create 返回 sessionId', JSON.parse(r.text()).sessionId === 'new-1');
  check('create 传了 cwd 且 reusable', calls.some(([n, v]) => n === 'create' && v.cwd === '/repo/a' && v.reusable === true));

  const r2 = await run('/editor-sessions/prompt', { method: 'POST', url: '/editor-sessions/prompt', body: { token: TOKEN, sessionId: 's1', text: '改一下' } });
  check('prompt 200', r2.statusCode === 200);
  const promptCall = calls.filter(([n]) => n === 'prompt').at(-1)[1];
  check('prompt 结构正确', promptCall.sessionId === 's1' && promptCall.content[0].type === 'text' && promptCall.content[0].text === '改一下');

  const r3 = await run('/editor-sessions/prompt', { method: 'POST', url: '/editor-sessions/prompt', body: { token: TOKEN, sessionId: 's1', text: '  ' } });
  check('空文本 → 400', r3.statusCode === 400);

  await run('/editor-sessions/cancel', { method: 'POST', url: '/editor-sessions/cancel', body: { token: TOKEN, sessionId: 's1' } });
  check('cancel 透传', calls.some(([n, v]) => n === 'cancel' && v.sessionId === 's1'));

  await run('/editor-sessions/rename', { method: 'POST', url: '/editor-sessions/rename', body: { token: TOKEN, sessionId: 's1', title: '新标题' } });
  check('rename 透传', calls.some(([n, v]) => n === 'rename' && v.title === '新标题'));
}

console.log('历史页');
{
  const r = await run('/editor-sessions/history', { url: `/editor-sessions/history?sessionId=s1&token=${TOKEN}` });
  check('history 200', r.statusCode === 200);
  const pageCall = calls.filter(([n]) => n === 'page').at(-1)[1];
  // address 必须是 {kind, sessionId}：写成 {kind, id} 会让 DSH 的 addressId
  // 取到 undefined，follow/page 直接报 "failed to observe session undefined"。
  check('address 形状正确', pageCall.address.kind === 'session' && pageCall.address.sessionId === 's1',
    JSON.stringify(pageCall.address));
  check('默认 maxMessages', pageCall.maxMessages === 50);
  // 不传 beforeSeq 时 DSH 会返回空页，所以必须兜底一个大值。
  // 同时必须避免 Number(null)===0 把「没传」误当成「从 0 取」。
  check('未指定 beforeSeq 时兜底成最大值', pageCall.beforeSeq === Number.MAX_SAFE_INTEGER,
    String(pageCall.beforeSeq));
  const body = JSON.parse(r.text());
  check('records 被解包成 events', body.events.length === 1 && body.events[0].type === 'turn/start',
    JSON.stringify(body));
}

console.log('实时流：三类帧 → SSE');
{
  const r = await run('/editor-sessions/stream', { url: `/editor-sessions/stream?sessionId=s1&token=${TOKEN}` });
  const events = parseEvents(r.text());
  const names = events.map((e) => e[0]);
  check('是 SSE', String(r.headers['content-type']).includes('text/event-stream'));
  check('snapshot 帧', names.includes('snapshot'));
  check('持久事件帧', names.includes('session-event'));
  check('助手开始帧', names.includes('assistant-start'));
  check('文字增量帧 x2', names.filter((n) => n === 'assistant-chunk').length === 2);
  check('未知帧不丢（显式透传）', names.includes('unknown-frame'));

  const chunks = events.filter((e) => e[0] === 'assistant-chunk').map((e) => e[1].text).join('');
  check('增量拼回文字', chunks === '正在执行', chunks);

  const toolEvent = events.find((e) => e[0] === 'session-event' && e[1].type === 'tool/call');
  check('工具事件带 name', toolEvent[1].data.name === 'read_file');
}

console.log('实时流：workspace/changes 必须放行并带 seq');
{
  // 只断言白名单字符串不够：过滤逻辑本身坏了照样漏。这里让 follow 真产出
  // 一个 workspace/changes，断言它出现在 SSE 里且 seq 原样透传。
  const followWithChanges = async function* () {
    yield { type: 'event', event: { seq: 33, type: 'workspace/changes', data: { turn: 1 } } };
    yield { type: 'event', event: { seq: 34, type: 'system/message', data: { big: 'x'.repeat(100) } } };
  };
  services = { sessionController: makeController({ follow: followWithChanges }) };
  const r = await run('/editor-sessions/stream', { url: `/editor-sessions/stream?sessionId=s1&token=${TOKEN}` });
  const events = parseEvents(r.text());
  const changes = events.filter((e) => e[0] === 'session-event' && e[1].type === 'workspace/changes');
  check('changes 事件出现在流里', changes.length === 1, String(changes.length));
  check('changes 事件带 seq', changes[0]?.[1]?.seq === 33, String(changes[0]?.[1]?.seq));
  check('changes 事件带 turn', changes[0]?.[1]?.data?.turn === 1);
  // 仍是白名单制：system/message 不该被放行（否则每条流放大一个量级）
  const sys = events.filter((e) => e[0] === 'session-event' && e[1].type === 'system/message');
  check('system/message 仍被过滤', sys.length === 0, String(sys.length));
}

console.log('服务缺失：显式 503');
{
  services = {};
  const r = await run('/editor-sessions/list', { url: `/editor-sessions/list?token=${TOKEN}` });
  check('list 503', r.statusCode === 503, String(r.statusCode));
  check('503 带原因', String(JSON.parse(r.text()).error).includes('sessionController'));
  const r2 = await run('/editor-sessions/stream', { url: `/editor-sessions/stream?sessionId=s1&token=${TOKEN}` });
  check('stream 503', r2.statusCode === 503, String(r2.statusCode));
}

console.log('Agent 改动：白名单 + changes 端点');
{
  // workspace/changes 必须被放行，否则前端拿不到「本轮改动」卡片。
  // 白名单是模块私有常量，直接读源码断言，避免为测试而扩大导出面。
  const srcText = readFileSync(join(HERE, '..', 'sessions.js'), 'utf8');
  const whitelist = srcText.slice(
    srcText.indexOf('const UI_EVENT_TYPES = new Set(['),
    srcText.indexOf(']);', srcText.indexOf('const UI_EVENT_TYPES = new Set([')),
  );
  check("workspace/changes 在白名单", whitelist.includes("'workspace/changes'"));

  const summary = {
    turn: 1,
    total: 2,
    added: 18,
    deleted: 3,
    files: [
      { path: '/repo/a/sessions.js', display: 'sessions.js', added: 12, deleted: 2 },
      { path: '/repo/a/chat.js', display: 'chat.js', added: 6, deleted: 1, binary: true },
    ],
  };
  const diffs = new Map();
  diffs.set('0', {
    kind: 'text', path: '/repo/a/sessions.js', display: 'sessions.js',
    before: true, after: true, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }],
  });
  diffs.set('1', { kind: 'binary', path: '/repo/a/chat.js', display: 'chat.js' });

  services = {
    sessionController: makeController(),
    workspaceChanges: {
      summary: (sessionId, seq) => (sessionId === 's1' && seq === 27 ? summary : undefined),
      diff: async (sessionId, seq, index) => {
        if (sessionId !== 's1' || seq !== 27) return undefined;
        return diffs.get(String(index));
      },
    },
  };

  const ok = await run('/editor-sessions/changes', { url: `/editor-sessions/changes?sessionId=s1&seq=27&token=${TOKEN}` });
  check('changes 200', ok.statusCode === 200, String(ok.statusCode));
  const body = JSON.parse(ok.text());
  check('changes 带 turn/total', body.turn === 1 && body.total === 2);
  check('changes 带增删行数', body.added === 18 && body.deleted === 3);
  check('changes 文件列表 2 条', body.files.length === 2);
  check('changes 保留 display 名', body.files[0].display === 'sessions.js');
  check('changes 保留 binary 标记', body.files[1].binary === true);

  const stale = await run('/editor-sessions/changes', { url: `/editor-sessions/changes?sessionId=s1&seq=99&token=${TOKEN}` });
  check('过期记录 404（不返回空列表）', stale.statusCode === 404, String(stale.statusCode));

  const badSeq = await run('/editor-sessions/changes', { url: `/editor-sessions/changes?sessionId=s1&seq=abc&token=${TOKEN}` });
  check('非法 seq 400', badSeq.statusCode === 400, String(badSeq.statusCode));

  // Number(null) === 0 会把「没传」当成「传了 0」，必须显式识别为 400
  const noSeq = await run('/editor-sessions/changes', { url: `/editor-sessions/changes?sessionId=s1&token=${TOKEN}` });
  check('缺 seq → 400（不是 404）', noSeq.statusCode === 400, String(noSeq.statusCode));
  const emptySeq = await run('/editor-sessions/changes', { url: `/editor-sessions/changes?sessionId=s1&seq=&token=${TOKEN}` });
  check('空 seq → 400', emptySeq.statusCode === 400, String(emptySeq.statusCode));

  const noAuth = await run('/editor-sessions/changes', { url: '/editor-sessions/changes?sessionId=s1&seq=27' });
  check('缺 token 401', noAuth.statusCode === 401, String(noAuth.statusCode));

  const d0 = await run('/editor-sessions/changes/diff', { url: `/editor-sessions/changes/diff?sessionId=s1&seq=27&index=0&token=${TOKEN}` });
  check('diff 200', d0.statusCode === 200, String(d0.statusCode));
  const diffBody = JSON.parse(d0.text());
  check('diff kind=text', diffBody.kind === 'text');
  check('diff 带 hunks', Array.isArray(diffBody.hunks) && diffBody.hunks.length === 1);
  check('diff before/after 是布尔', diffBody.before === true && diffBody.after === true);

  const d1 = await run('/editor-sessions/changes/diff', { url: `/editor-sessions/changes/diff?sessionId=s1&seq=27&index=1&token=${TOKEN}` });
  check('二进制文件仍是 200 + kind', d1.statusCode === 200 && JSON.parse(d1.text()).kind === 'binary');

  const badIndex = await run('/editor-sessions/changes/diff', { url: `/editor-sessions/changes/diff?sessionId=s1&seq=27&index=x&token=${TOKEN}` });
  check('非法 index 400', badIndex.statusCode === 400, String(badIndex.statusCode));

  // 缺 index 若被当成 0，会静默返回**另一个文件**的 diff —— 必须挡住
  const noIndex = await run('/editor-sessions/changes/diff', { url: `/editor-sessions/changes/diff?sessionId=s1&seq=27&token=${TOKEN}` });
  check('缺 index → 400（不静默取 0）', noIndex.statusCode === 400, String(noIndex.statusCode));
  const noSeq2 = await run('/editor-sessions/changes/diff', { url: `/editor-sessions/changes/diff?sessionId=s1&index=0&token=${TOKEN}` });
  check('diff 缺 seq → 400', noSeq2.statusCode === 400, String(noSeq2.statusCode));

  // workspaceChanges 缺失 → 503 且有原因，不静默
  services = { sessionController: makeController() };
  const gone = await run('/editor-sessions/changes', { url: `/editor-sessions/changes?sessionId=s1&seq=27&token=${TOKEN}` });
  check('无 workspaceChanges 时 503', gone.statusCode === 503, String(gone.statusCode));
  check('503 说明改动服务缺失', String(JSON.parse(gone.text()).error).includes('改动'));
}

console.log(failed === 0 ? 'PASS: 会话桥契约全部通过' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);
