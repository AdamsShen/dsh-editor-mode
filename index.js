/**
 * DSH 编辑器模式 —— Host 半边（路线 A：DSH 单窗口内嵌 VS Code）。
 *
 * 职责：
 *  1. 启动并托管本地 code-server 子进程（回环监听，auth none，独立进程组）。
 *  2. 暴露 /editor-status 给 Client 读取真实 upstream 地址与项目目录。
 *  3. 保留 /editor/ 前缀 HTTP 反代与 WebSocket upgrade 占位：S1 的 Client 改为
 *     iframe 直连回环（因为 code-server 的 WS 走多条动态路径，DSH registerUpgrade
 *     只支持 exact path），同源反代留到后续阶段统一处理全部 upgrade 路径。
 *  4. 用 ctx.connection.requestRejection 做 Host/Origin 围栏 + 浏览器鉴权。
 *
 * 边界（当前阶段有意不做）：
 *  - 不自带运行时下载/校验，使用 config.runtimeDir 指向已安装目录；
 *  - 不做多实例复用、崩溃自动重启、优雅停机之外的清理；
 *  - 不做编辑器←→Agent 的消息桥（那是后续联动阶段）。
 */

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const EDITOR_PREFIX = '/editor/';
const EDITOR_WS_PATH = '/editor/';

/** 把 `~/...` 展开成绝对路径；其余保持原样。 */
function expand(p) {
  if (!p) return '';
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p);
}

/** 子进程的 stdout/stderr 只记内存尾部，避免无界增长。 */
function tailLog(entry) {
  const chunks = [];
  const push = (buf) => {
    chunks.push(String(buf));
    if (chunks.length > 50) chunks.shift();
    entry.log = chunks.join('').slice(-16000);
  };
  return push;
}

/** 找到 code-server 的入口脚本。 */
function findEntry(runtimeDir) {
  const candidates = [
    join(runtimeDir, 'node_modules', 'code-server', 'out', 'node', 'entry.js'),
    join(runtimeDir, 'out', 'node', 'entry.js'),
    join(runtimeDir, 'lib', 'vscode', 'out', 'node', 'entry.js'),
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * 找到一个能跑 code-server 的真实 node 可执行文件。
 *
 * 关键：DSH 的 Host 是 Electron 进程，process.execPath 指向 Electron 主程序，
 * 不是 node —— 用它启动会把 code-server 的 entry.js 当成 Electron app 加载，
 * 行为异常（实测上游返回 302 而非 workbench 200）。绝不能回退到 process.execPath。
 */
function findNode() {
  const candidates = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // 最后才用 PATH 解析（Node 自身可执行的场景）；仍不是 Electron。
  return 'node';
}

/**
 * 探测端口是否可绑定。返回 true 表示空闲。
 * 只做一次短监听后立即关闭，不与真正启动的上游竞争（存在极小竞态窗口，
 * 但 code-server 启动失败会写进 log 并通过 status 暴露，不会静默）。
 */
async function portFree(port, host) {
  return new Promise((resolveFree) => {
    const srv = createNetServer();
    srv.once('error', () => resolveFree(false));
    srv.listen(port, host, () => srv.close(() => resolveFree(true)));
  });
}

/**
 * 选一个可用端口：优先配置值，被占用时在 [配置值, 配置值+20) 内找空闲端口。
 * 这样多开 DSH 或残留进程时不会 EADDRINUSE 起不来。
 */
async function pickPort(configured, host) {
  const base = Number(configured) || 3999;
  for (let p = base; p < base + 20; p++) {
    if (await portFree(p, host)) return p;
  }
  return base; // 全占用时仍回退，让 code-server 自己报错并写进 log
}

/**
 * 启动 code-server。返回 { child, state }；失败时抛错，由 apply 转成可展示的状态。
 * 说明：本机 DSH 自带 node 带 hardened runtime，会拒绝加载 argon2 的第三方签名原生模块，
 * 因此固定用系统 node + FORCE_NODE_VERSION=24 绕过版本门禁（已实测可启动）。
 * 生产版应改自带兼容 node 或重签原生模块。
 */
async function startServer(config, ctx) {
  const runtimeDir = expand(config.runtimeDir || '~/.dsh/editor-runtime');
  const entry = findEntry(runtimeDir);
  if (!entry) throw new Error(`code-server 未安装：在 ${runtimeDir} 下找不到 out/node/entry.js`);

  const nodeBin = expand(config.nodeBin || '') || findNode();
  const host = config.upstreamHost || '127.0.0.1';
  const port = await pickPort(config.upstreamPort, host);
  const workspace = expand(config.workspaceDir || '') || resolve(homedir(), 'dsh-editor-mode');

  const args = [
    entry,
    '--bind-addr', `${host}:${port}`,
    '--auth', 'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--trusted-origins', '*',
    workspace,
  ];

  const env = { ...process.env, FORCE_NODE_VERSION: '24' };
  const child = spawn(nodeBin, args, {
    cwd: runtimeDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 独立进程组：卸载时按组 kill，避免 npm/子进程残留成孤儿。
    detached: true,
  });

  const state = { pid: child.pid, log: '', startedAt: Date.now(), port, workspace, upstream: `http://${host}:${port}` };
  const log = tailLog(state);
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);
  child.on('error', log);
  child.on('exit', (code, signal) => { log(`[exit] code=${code} signal=${signal}\n`); });

  return { child, state };
}

/**
 * 等待上游 workbench 真正可用（最多 ~20s）。
 * 注意：code-server 的 /healthz 在 HTTP 监听后立刻返回 200，但 workbench 初始化
 * （扩展主机、shared storage）还要几秒；过早反代会让首屏请求落到半初始化状态。
 * 因此这里探测根页面并确认返回的是 workbench HTML。
 */
async function waitReady(state, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${state.upstream}/`, { signal: AbortSignal.timeout(2000) });
      const text = await res.text();
      if (res.ok && text.includes('vscode-workbench-web-configuration')) return true;
    } catch { /* 未起来，继续 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 把 DSH 侧 /editor/xxx 的路径映射到上游，保留 query。 */
function upstreamUrl(state, reqUrl) {
  const u = new URL(reqUrl, 'http://localhost');
  // /editor/ -> / ; /editor/foo -> /foo
  const path = u.pathname.slice(EDITOR_PREFIX.length - 1) || '/';
  return new URL(path + u.search, state.upstream);
}

/** 拒绝未通过 DSH 鉴权的请求；返回 true 表示已应答。 */
function rejected(ctx, req, res) {
  const conn = ctx.get('connection');
  if (!conn) return false;
  const status = conn.requestRejection(req);
  if (status === undefined) return false;
  res.statusCode = status;
  res.end();
  return true;
}

/** HTTP 反代：把 /editor/... 转发到 code-server，回写状态/头/流。 */
function proxyHttp(ctx, state, req, res) {
  if (rejected(ctx, req, res)) return;
  const target = upstreamUrl(state, req.url);
  const headers = { ...req.headers };
  // 去掉只对 DSH 有意义的 hop-by-hop / 鉴权头
  delete headers.host;
  delete headers.cookie;
  delete headers['accept-encoding'];
  headers.host = target.host;

  const up = httpRequest(target, {
    method: req.method,
    headers,
    timeout: 30000,
  }, (upRes) => {
    // code-server 自身的 CSP 允许它被同源 iframe 嵌入；我们只移除会阻断的 X-Frame-Options。
    const out = { ...upRes.headers };
    delete out['x-frame-options'];
    delete out['content-security-policy'];
    delete out['content-security-policy-report-only'];
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (err) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`编辑器上游不可用：${err.message}`);
  });
  req.pipe(up);
}

/**
 * WebSocket 反代：用裸 TCP 把 upgrade 后的字节在浏览器与 code-server 之间对拷。
 * code-server 的 WebSocket 走 / 路径并需要正确的 Host/Origin，这里构造等价的 upgrade 请求。
 */
function proxyUpgrade(ctx, state, req, socket, head) {
  const conn = ctx.get('connection');
  const status = conn?.requestRejection(req);
  if (status !== undefined) {
    socket.write(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  const target = upstreamUrl(state, req.url);
  const key = req.headers['sec-websocket-key'];
  const lines = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key ?? randomBytes(16).toString('base64')}`,
    `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] ?? '13'}`,
  ];
  if (req.headers['sec-websocket-protocol']) {
    lines.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
  }
  if (req.headers.origin) lines.push(`Origin: ${target.origin}`);
  lines.push('', '');

  const up = netConnect(Number(target.port), target.hostname, () => {
    up.write(lines.join('\r\n'));
    if (head?.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.setTimeout(0);
  socket.setTimeout(0);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  up.on('close', () => socket.destroy());
  socket.on('close', () => up.destroy());
}

export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer');
  if (!webServer) throw new Error('editor-mode 需要 webServer 服务（当前 profile 未挂载）');

  // 轻量校验：config 无 schema，靠这里兜住明显错配，避免端口/路径非法时静默失败。
  const port = Number(config.upstreamPort ?? 3999);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`editor-mode: upstreamPort 必须是 1..65535，收到 ${String(config.upstreamPort)}`);
  }
  void port;

  const state0 = { status: 'starting', upstream: '', workspace: '', log: '' };
  let runtime = null;

  // 以 status 端点暴露 PoC 状态，便于验证与排障。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/editor-status',
    handler: (req, res) => {
      if (rejected(ctx, req, res)) return;
      const s = runtime?.state ?? state0;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        status: s.status ?? (runtime ? 'ready' : 'starting'),
        pid: s.pid,
        upstream: s.upstream,
        workspace: s.workspace,
        // Client 用它拼 ?folder=，让 code-server 打开插件配置的项目目录。
        folder: s.workspace || '',
        log: (s.log || '').slice(-4000),
      }));
    },
  }), 'editor-mode: GET /editor-status');

  // 主反代路由：所有 /editor/ 下的 HTTP 请求。
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: EDITOR_PREFIX,
    handler: (req, res) => {
      if (!runtime) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('编辑器正在启动，请稍后重试');
        return;
      }
      proxyHttp(ctx, runtime.state, req, res);
    },
  }), 'editor-mode: /editor/* HTTP proxy');

  // WebSocket upgrade：code-server 的终端/扩展主机依赖长连接。
  ctx.effect(() => webServer.registerUpgrade({
    path: EDITOR_WS_PATH,
    handler: (req, socket, head) => {
      if (!runtime) { socket.destroy(); return; }
      proxyUpgrade(ctx, runtime.state, req, socket, head);
    },
  }), 'editor-mode: /editor/ WebSocket proxy');

  // 启动上游。
  const boot = (async () => {
    try {
      runtime = await startServer(config, ctx);
      state0.status = 'starting';
      const ok = await waitReady(runtime.state, runtime.child);
      runtime.state.status = ok ? 'ready' : 'degraded';
      ctx.logger?.info?.(`[editor-mode] code-server ${ok ? 'ready' : 'degraded'} at ${runtime.state.upstream}`);
    } catch (err) {
      state0.status = 'failed';
      state0.log = String(err?.stack || err);
      ctx.logger?.warn?.(`[editor-mode] 启动失败：${state0.log}`);
    }
  })();

  // 卸载时终止整组子进程（含其派生的扩展主机 / PTY），并释放路由。
  // 用独立进程组的负 pid，避免主进程退出后留下无法回收的孤儿。
  ctx.effect(() => {
    const stop = () => {
      const child = runtime?.child;
      if (!child || child.exitCode !== null) return;
      const kill = (sig) => {
        try {
          if (child.pid) process.kill(-child.pid, sig); // 整个进程组
        } catch {
          try { child.kill(sig); } catch { /* 已退出 */ }
        }
      };
      kill('SIGTERM');
      const t = setTimeout(() => kill('SIGKILL'), 4000);
      t.unref?.();
    };
    // 进程级兜底：即使 fiber 清理未被调用（例如 HMR 重建），Host 退出也会带走子进程。
    process.once('exit', stop);
    return () => {
      process.removeListener('exit', stop);
      stop();
    };
  });
  void boot;

  return { state: state0, getRuntime: () => runtime };
}
