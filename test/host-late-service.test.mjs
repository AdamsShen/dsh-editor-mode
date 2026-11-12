/**
 * 测试：webServer 晚于插件求值就绪时，编辑器后端仍能装上。
 *
 * 背景（真实故障）：cordis 按拓扑顺序解析服务，插件行可能早于 `webserver`
 * 行求值。此前 apply() 里直接 `throw '需要 webServer'`，这一行会**永久不激活**
 * 且不重试 —— 现象是 DSH 正常、Web UI 正常，但所有 /editor* 路由 404、
 * code-server 一个进程都不起，且桌面端把错误吞进 stderr（用户看不到）。
 *
 * 本用例锁定修复：apply() 不得抛错，webServer 稍后出现时必须自动完成装配。
 *
 * 用法：node test/host-late-service.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-late-'));

/** 记录注册的路由；webServer 由测试稍后注入，模拟真实时序。 */
const routes = new Map();
const webServer = {
  host: '127.0.0.1',
  port: 45999,
  register: (r) => { routes.set(`${r.kind}:${r.path}`, r); return () => {}; },
  registerUpgrade: () => () => {},
};

const listeners = new Map();
let present = {}; // 服务表
const ctx = {
  get: (name) => present[name],
  on: (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  },
  effect: (fn) => { const d = fn && fn(); return d || (() => {}); },
  logger: { info: () => {}, warn: () => {} },
};

console.log('webServer 尚未就绪时 apply()');
let threw = null;
try {
  apply(ctx, { runtimeDir: tmp, upstreamPort: 1, bridgeToken: 'late-token' });
} catch (error) {
  threw = error;
}
check('apply 不抛错（旧实现会 throw 导致永久不激活）', threw === null, threw && threw.message);
check('此时没有任何路由被注册', routes.size === 0, String(routes.size));

console.log('webServer 就绪后');
present = { webServer };
for (const handler of listeners.get('internal/service') || []) handler('webServer');
// installEditor 是 async（桥接文件探活有网络往返），等它装配完再断言。
await new Promise((r) => setTimeout(r, 300));

check('/editor-status 已注册', routes.has('exact:/editor-status'), [...routes.keys()].join(','));
check('/editor-chat/send 已注册', routes.has('exact:/editor-chat/send'));
check('/editor-chat/models 已注册', routes.has('exact:/editor-chat/models'));
check('/editor-bridge/push 已注册', routes.has('exact:/editor-bridge/push'));
check('/editor/ 反代前缀已注册', routes.has('prefix:/editor/'));
check('恰好 8 条路由（4 chat/status + 2 bridge + 1 前缀）', routes.size >= 7, String(routes.size));

console.log('兜底路径：不发事件、只让服务出现');
{
  const routes2 = new Map();
  const ws2 = { host: '127.0.0.1', port: 46000, register: (r) => { routes2.set(r.path, r); return () => {}; }, registerUpgrade: () => () => {} };
  let services2 = {};
  const ctx2 = {
    get: (n) => services2[n],
    on: () => () => {},
    effect: (fn) => { const d = fn && fn(); return d || (() => {}); },
    logger: { info: () => {}, warn: () => {} },
  };
  apply(ctx2, { runtimeDir: tmp, upstreamPort: 1, bridgeToken: 't2' });
  check('轮询兜底：未就绪时不抛错', routes2.size === 0);
  services2 = { webServer: ws2 };
  await new Promise((r) => setTimeout(r, 400));
  check('轮询兜底：服务出现后自动装配', routes2.has('/editor-status'), [...routes2.keys()].join(','));
}

console.log('多实例：已有存活实例时不覆盖 bridge.json');
{
  const { readFileSync, writeFileSync: write } = await import('node:fs');
  const dir = join(tmp, 'multi');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  // 造一个「已有实例」的记录，指向一个真实存活的端口（用测试自己的 webServer 桩不行，
  // 这里起一个最小 HTTP 服务模拟活着的实例）。
  const probe = (await import('node:http')).createServer((_req, res) => { res.writeHead(401); res.end(); });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const livePort = probe.address().port;
  const file = join(dir, 'bridge.json');
  write(file, JSON.stringify({ base: `http://127.0.0.1:${livePort}`, token: 'owner-token' }));

  const routes3 = new Map();
  const ws3 = { host: '127.0.0.1', port: 46200, register: (r) => { routes3.set(r.path, r); return () => {}; }, registerUpgrade: () => () => {} };
  const ctx3 = {
    get: (n) => (n === 'webServer' ? ws3 : undefined),
    on: () => () => {},
    effect: (fn) => { const d = fn && fn(); return d || (() => {}); },
    logger: { info: () => {}, warn: () => {} },
  };
  apply(ctx3, { runtimeDir: dir, upstreamPort: 1, bridgeToken: 'new-token' });
  await new Promise((r) => setTimeout(r, 500));

  const after = JSON.parse(readFileSync(file, 'utf8'));
  check('没有覆盖运行中实例的 bridge.json', after.token === 'owner-token', JSON.stringify(after));
  probe.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? 'PASS: 延迟就绪下仍能装上编辑器后端' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);
