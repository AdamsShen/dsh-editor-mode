/**
 * 回归测试：验证 client.js 每个槽的 inject 回调在真实执行路径下不抛错。
 *
 * 背景：cordis 中访问未在 `inject` 列表声明的服务会直接抛
 * `Service not found: <name>`。这个错误发生在槽渲染时，会导致整个
 * main 面板白屏（表现为「打开编辑器模式一片空白、连标题栏都没有」）。
 * 历史上就因为写成 `ctx.uiWorkspace || ctx.get('uiWorkspace')` 触发过一次。
 *
 * 用法：node test/client-inject.test.mjs [client.js 路径]
 * 缺省测试仓库根目录的 client.js。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(HERE, '..', 'client.js');
const src = readFileSync(file, 'utf8');
let registered = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { registered = def; } } };
new Function(src)();

const mod = registered.factory((name) => {
  if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f, useSyncExternalStore: () => null };
  throw new Error('unexpected require: ' + name);
});

const regs = [];
const services = {
  slots: {
    inject: (key, cb) => { cb(); return () => {}; },
    register: (opts, comp) => { regs.push({ opts, comp }); return () => {}; },
  },
  layout: { selectPanel: () => {}, panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } },
  sessions: { scope: () => undefined },
};
// 模拟 cordis：inject 列表外的服务直接访问 → 抛错（这是白屏根因）
const ctx = new Proxy({ get: (n) => services[n], effect: (fn) => { const d = fn && fn(); return d || (() => {}); } }, {
  get(t, prop) {
    if (prop in services) return services[prop];
    if (prop in t) return t[prop];
    throw new Error(`Service not found: ${String(prop)}`);
  },
});

mod.apply(ctx);
console.log('注册槽数:', regs.length);

// 逐个调用 inject 回调 —— 这正是渲染时的执行路径
let failed = 0;
for (const r of regs) {
  const inject = r.opts.inject;
  if (!inject) continue;
  try {
    const arg = r.opts.key ? undefined : 'session-x';
    const props = inject(arg);
    console.log('  ✓', r.opts.name, r.opts.key || r.opts.id, '→ props:', Object.keys(props).join(','));
  } catch (e) {
    failed++;
    console.log('  ✗', r.opts.name, r.opts.key || r.opts.id, '→ 抛错:', e.message);
  }
}
console.log(failed === 0 ? 'PASS: 所有 inject 回调无异常' : `FAIL: ${failed} 个 inject 回调抛错`);
setTimeout(() => process.exit(failed ? 1 : 0), 100);
