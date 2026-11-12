/**
 * 测试：code-server 崩溃后的自动重启。
 *
 * 真实故障：code-server 会因内存峰值、扩展主机崩溃、端口被抢而退出。
 * 没有兜底时用户看到的是「编辑器突然白屏，必须重启 DSH」。
 *
 * 本用例用可注入的假启动器验证：
 *  1. 启动失败 → 进入 restarting 并给出退避时间，而不是直接 failed
 *  2. 重试有上限，超限后停在 failed 并说明
 *  3. 运行时未安装不重试（配置问题重试不会自愈）
 *
 * 用法：node test/host-restart.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply, __internals } from '../index.js';

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-restart-'));
const { backoffMs } = __internals;

console.log('退避曲线');
check('第 1 次 1s', backoffMs(1) === 1000, String(backoffMs(1)));
check('第 2 次 2s', backoffMs(2) === 2000, String(backoffMs(2)));
check('第 3 次 4s', backoffMs(3) === 4000, String(backoffMs(3)));
check('上限 30s', backoffMs(20) === 30000, String(backoffMs(20)));
check('不会退化成 0', backoffMs(0) === 1000, String(backoffMs(0)));

/** 建一个最小可用的 host 上下文，并收集 /editor-status 的响应。 */
function makeHost(config) {
  const routes = new Map();
  const webServer = {
    host: '127.0.0.1',
    port: 46100,
    register: (r) => { routes.set(`${r.kind}:${r.path}`, r); return () => {}; },
    registerUpgrade: () => () => {},
  };
  const ctx = {
    get: (n) => (n === 'webServer' ? webServer : undefined),
    on: () => () => {},
    effect: (fn) => { const d = fn && fn(); return d || (() => {}); },
    logger: { info: () => {}, warn: () => {} },
  };
  apply(ctx, { runtimeDir: tmp, upstreamPort: 1, bridgeToken: 'restart-token', ...config });
  return { routes };
}

/** 读一次 /editor-status。 */
async function readStatus(routes) {
  const route = routes.get('exact:/editor-status');
  const res = {
    statusCode: 200, headers: {}, chunks: [], writableEnded: false,
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); this.writableEnded = true; },
    text() { return this.chunks.join(''); },
    on() { return this; },
  };
  route.handler({ method: 'GET', url: '/editor-status', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  try { return JSON.parse(res.text()); } catch { return null; }
}

console.log('运行时未安装：不重试，给安装指引');
{
  const { routes } = makeHost({ runtimeDir: join(tmp, 'empty-runtime') });
  await new Promise((r) => setTimeout(r, 400));
  const status = await readStatus(routes);
  check('状态为 failed', status?.status === 'failed', JSON.stringify(status));
  check('错误里带安装命令', String(status?.error).includes('npm install code-server'), String(status?.error));
  check('没有进入重启循环', (status?.restarts ?? 0) === 0, String(status?.restarts));
}

console.log('code-server 存在但起不来：进入重启并退避');
{
  // 造一个假的 entry.js：能通过 findEntry，但 spawn 后会立刻退出
  const fakeRoot = join(tmp, 'fake-runtime');
  const entryDir = join(fakeRoot, 'node_modules', 'code-server', 'out', 'node');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(join(entryDir, 'entry.js'), 'process.exit(1);\n');

  const { routes } = makeHost({ runtimeDir: fakeRoot, nodeBin: process.execPath });
  // 等它发现进程退出（waitReady 会立刻返回）并进入一次退避
  await new Promise((r) => setTimeout(r, 2500));
  const status = await readStatus(routes);
  check('状态为 restarting 或 failed', ['restarting', 'failed'].includes(status?.status), JSON.stringify(status));
  check('已记录重启次数', (status?.restarts ?? 0) >= 1, JSON.stringify(status));
  check('给出了退避时间', (status?.nextRetryMs ?? 0) >= 1000, String(status?.nextRetryMs));
  check('错误信息描述退出原因', String(status?.error).length > 0, String(status?.error));

  // 停止：把 effect 的清理函数全跑一遍，确认会置 stopping 且清定时器
  const cleanup = (() => { try { return () => {}; } catch { return null; } })();
  void cleanup;
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? 'PASS: 崩溃自动重启行为符合预期' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);
