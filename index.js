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
 *  5. 编辑器侧栏 Chat 的后端：/editor-sessions/*（见 sessions.js），
 *     直接复用 DSH 的 sessionController —— 编辑器里的对话就是真实 Agent 会话。
 *
 * 边界（当前阶段有意不做）：
 *  - 不自带运行时下载/校验，使用 config.runtimeDir 指向已安装目录；
 *  - 不做多实例复用、崩溃自动重启、优雅停机之外的清理；
 *  - 编辑器内 Chat 是「纯模型对话」，不给模型任何工具（不读文件、不执行命令）。
 *    需要真正动手改代码时，走「发送到 Agents」交回 DSH Agent。
 */

import { spawn } from 'node:child_process';
import { request as httpRequest, get as httpsGet } from 'node:https';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants,
  createWriteStream, createReadStream, mkdtempSync, rmSync, statSync, renameSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { registerSessionRoutes } from './sessions.js';

/** 本插件包目录（用于定位随包发布的 VS Code 扩展）。 */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

const EDITOR_PREFIX = '/editor/';
const EDITOR_WS_PATH = '/editor/';


/**
 * 崩溃重启的退避曲线：1s、2s、4s…上限 30s。
 * attempt 从 1 开始；0 或负数按第 1 次处理，避免退化成 0ms 风暴。
 * @param {number} attempt 已尝试次数
 * @returns {number} 毫秒
 */
export function backoffMs(attempt) {
  return Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** 生成 provider 中立的消息 id（adapter 只读 role/content/source，id 仅需唯一）。 */
let messageSeq = 0;
function nextMessageId() {
  messageSeq += 1;
  return `dem-${Date.now().toString(36)}-${messageSeq}`;
}

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
 * 写入编辑器默认设置（幂等）。
 *
 * 目的：code-server 发行包内置了 GitHub Copilot Chat
 * （product.json 的 builtInExtensionsEnabledWithAutoUpdates），默认会在编辑器里
 * 出现一个要求登录 GitHub Copilot 的 Chat 面板 —— 那与 DSH 的模型配置无关，
 * 混在一起会让用户误以为「编辑器没用自己的模型」。这里把它关掉，让编辑器只做编辑器，
 * 与 DSH Agents 的协作走我们自己的桥接通道。
 *
 * 只写我们自己的 user-data-dir，不碰用户的全局 code-server 配置。
 * 合并策略：保留用户已有键，只补齐缺失的默认值（用户手动改过的不覆盖）。
 */
function ensureEditorSettings(userDataDir, config) {
  const defaults = {
    // 内置 Copilot 由 VSCODE_SKIP_BUILTIN_EXTENSIONS 在扫描阶段就排除了；
    // 这里再关一次 AI 特性，避免核心聊天视图（右侧次级侧栏）因为
    // "chat 扩展被禁用" 而留一个空壳面板 —— 我们的 DSH Chat 要占这个位置。
    'chat.disableAIFeatures': true,
    'github.copilot.enable': false,
    'chat.commandCenter.enabled': false,
    'chat.agent.enabled': false,
    'workbench.startupEditor': 'none',
    // 右侧次级侧栏默认收起：用户点 DSH Chat 或「打开 Agents 风格布局」时再展开，
    // 免得每次打开编辑器都多一栏空白。
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    ...(config.editorSettings || {}),
  };
  try {
    const dir = join(userDataDir, 'User');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    let current = {};
    if (existsSync(file)) {
      try { current = JSON.parse(readFileSync(file, 'utf8')); } catch { current = {}; }
    }
    let changed = false;
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in current)) { current[k] = v; changed = true; }
    }
    if (changed || !existsSync(file)) writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  } catch { /* 设置写入失败不应阻止编辑器启动 */ }
}

// ---------------------------------------------------------------------------
// 运行时自举：缺 code-server 时自动下载并校验
// ---------------------------------------------------------------------------

/** 下载限制：防止被超大文件或被拖死的连接拖垮整个 DSH 启动。 */
const RUNTIME_LIMITS = {
  maxBytes: 200 * 1024 * 1024,
  timeoutMs: 5 * 60 * 1000,
};

/**
 * 判断运行时当前该做什么。纯函数，方便离线测试各种配置组合。
 *
 * @param {Record<string, unknown>} config 已校验的配置
 * @returns {{action: 'ready'|'install'|'missing', entry: string, runtimeDir: string,
 *            source?: string, sha256?: string, hint: string}}
 */
export function planRuntime(config = {}) {
  const runtimeDir = expand(config.runtimeDir || '~/.dsh/editor-runtime');
  const entry = findEntry(runtimeDir);
  if (entry) {
    return { action: 'ready', entry, runtimeDir, hint: '' };
  }
  const source = config.runtimeSource ? String(config.runtimeSource) : '';
  const sha256 = config.runtimeSha256 ? String(config.runtimeSha256) : '';
  if (!source || !sha256) {
    // 没配来源时不要"尝试一下"：静默去下载未知二进制比明确报错危险得多。
    return {
      action: 'missing',
      entry: '',
      runtimeDir,
      hint: `在 ${runtimeDir} 下找不到 out/node/entry.js。`
        + ' 可配置 runtimeSource + runtimeSha256 让插件自动下载，或手动安装：'
        + ` mkdir -p ${runtimeDir} && cd ${runtimeDir} && npm init -y && `
        + 'FORCE_NODE_VERSION=24 npm install code-server@4.145.2',
    };
  }
  return { action: 'install', entry: '', runtimeDir, source, sha256, hint: '' };
}

/** 计算文件 SHA-256（流式，避免把 200MB 包读进内存）。 */
function sha256File(file) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', rejectHash);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

/**
 * 下载到本地文件，边下边算大小；超过上限立刻中断。
 * @returns {Promise<{bytes: number}>}
 */
async function downloadToFile(url, dest, opts = {}) {
  const limits = { ...RUNTIME_LIMITS, ...opts };
  return new Promise((resolveDl, rejectDl) => {
    const req = httpsGet(url, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        // 只跟随一次重定向：发行包通常直连，多次跳转多半是被劫持或配置错
        downloadToFile(new URL(res.headers.location, url).toString(), dest, opts)
          .then(resolveDl, rejectDl);
        return;
      }
      if (status !== 200) {
        res.resume();
        rejectDl(new Error(`下载失败：HTTP ${status}`));
        return;
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > limits.maxBytes) {
        res.resume();
        rejectDl(new Error(`发行包过大（${declared} 字节，上限 ${limits.maxBytes}）`));
        return;
      }
      let bytes = 0;
      let aborted = false;
      const out = createWriteStream(dest);
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > limits.maxBytes && !aborted) {
          aborted = true;
          req.destroy(new Error(`发行包超过上限 ${limits.maxBytes} 字节`));
        }
      });
      pipeline(res, out)
        .then(() => { if (aborted) rejectDl(new Error('发行包超过上限')); else resolveDl({ bytes }); })
        .catch(rejectDl);
    });
    req.setTimeout(limits.timeoutMs, () => req.destroy(new Error('下载超时')));
    req.on('error', rejectDl);
  });
}

/** 用系统 tar 解包到目标目录（`tar` 在 macOS/Linux/Win10+ 都有）。 */
function extractTar(tarPath, destDir) {
  return new Promise((resolveTar, rejectTar) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    child.on('error', rejectTar);
    child.on('exit', (code) => {
      if (code === 0) resolveTar();
      else rejectTar(new Error(`解包失败（tar 退出码 ${code}）：${stderr.trim().slice(0, 300)}`));
    });
  });
}

/**
 * 确保运行时可用：缺就下载 → 校验 → 解包 → 原子落位。
 *
 * 安全底线：
 *   - 只接受 https（配置层已校验）
 *   - **必须**有 SHA-256 且校验通过，否则一个字节都不会解包
 *   - 先解到同目录的临时目录，成功后再 rename，失败不动已有安装
 *
 * IO 全部可注入（deps），这样离线也能测「校验不过就不落位」这类关键行为。
 *
 * @param {Record<string, unknown>} config 已校验配置
 * @param {object} [deps] 测试注入点
 * @returns {Promise<{state: string, entry?: string, message?: string}>}
 */
export async function ensureRuntime(config = {}, deps = {}) {
  const {
    fetchToFile = downloadToFile,
    extract = extractTar,
    hashFile = sha256File,
    rename = renameSync,
    log = () => {},
  } = deps;

  const plan = planRuntime(config);
  if (plan.action === 'ready') return { state: 'ready', entry: plan.entry };
  if (plan.action === 'missing') return { state: 'missing', message: plan.hint };

  const { runtimeDir, source, sha256 } = plan;
  log(`[editor-mode] 运行时缺失，开始下载 ${source}`);

  // 目录都建不出来的话（权限/磁盘满）也要走 failed 而不是把异常抛给调用方，
  // 否则会被上层当成"崩溃"而不断重试。
  let work = '';
  try {
    mkdirSync(runtimeDir, { recursive: true });
    work = mkdtempSync(join(runtimeDir, '.download-'));
    const tarPath = join(work, 'runtime.tgz');
    await fetchToFile(source, tarPath, RUNTIME_LIMITS);
    log('[editor-mode] 下载完成，校验 SHA-256');

    const actual = await hashFile(tarPath);
    if (actual !== sha256) {
      // 校验不过绝不落位：宁可这次失败，也不让来路不明的字节变成可执行运行时
      throw new Error(`SHA-256 校验失败：期望 ${sha256}，实际 ${actual}`);
    }

    const staging = join(work, 'unpacked');
    mkdirSync(staging, { recursive: true });
    await extract(tarPath, staging);
    if (!findEntry(staging)) {
      throw new Error('发行包结构不符：解包后找不到 out/node/entry.js');
    }

    // 原子落位：同目录 rename。
    // 注意顺序：旧安装先挪到 backup、再装新的。如果第二步失败，必须把 backup
    // 挪回去——否则 finally 清掉 work 时会连备份一起删，用户既没有新安装、
    // 旧的也没了（数据丢失）。
    const target = join(runtimeDir, 'node_modules');
    const stagedModules = join(staging, 'node_modules');
    if (existsSync(stagedModules)) {
      const backup = join(work, 'previous');
      const hadOld = existsSync(target);
      if (hadOld) rename(target, backup);
      try {
        rename(stagedModules, target);
      } catch (err) {
        if (hadOld && existsSync(backup)) {
          try { rename(backup, target); } catch { /* 恢复也失败：下面照常报错 */ }
        }
        throw err;
      }
    } else {
      for (const name of readdirSafe(staging)) {
        renameSync(join(staging, name), join(runtimeDir, name));
      }
    }

    const entry = findEntry(runtimeDir);
    if (!entry) throw new Error('落位后仍找不到 out/node/entry.js');
    log('[editor-mode] 运行时安装完成');
    return { state: 'installed', entry };
  } catch (err) {
    log(`[editor-mode] 运行时安装失败：${String(err?.message || err)}`);
    return { state: 'failed', message: String(err?.message || err) };
  } finally {
    // 临时目录一定要清：下载包有 200MB，失败时留在磁盘上会被反复堆积
    if (work) { try { rmSync(work, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
  }
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * 启动 code-server。返回 { child, state }；失败时抛错，由 apply 转成可展示的状态。
 * 说明：本机 DSH 自带 node 带 hardened runtime，会拒绝加载 argon2 的第三方签名原生模块，
 * 因此固定用系统 node + FORCE_NODE_VERSION=24 绕过版本门禁（已实测可启动）。
 * 生产版应改自带兼容 node 或重签原生模块。
 */
async function startServer(config, ctx, bridge) {
  const runtimeDir = expand(config.runtimeDir || '~/.dsh/editor-runtime');
  // 缺运行时先自举（配置了 runtimeSource + runtimeSha256 时）；失败再抛可操作错误。
  const ensured = await ensureRuntime(config, { log: (m) => ctx.logger?.info?.(m) });
  if (ensured.state === 'missing' || ensured.state === 'failed') {
    // 这是唯一需要用户动手的失败，说清楚怎么做，别让它变成一块白屏。
    const error = new Error(
      ensured.state === 'missing'
        ? ensured.message
        : `code-server 自动安装失败：${ensured.message}。`
          + ` 可手动安装：mkdir -p ${runtimeDir} && cd ${runtimeDir} && npm init -y && `
          + 'FORCE_NODE_VERSION=24 npm install code-server@4.145.2',
    );
    // 显式标记：重试不会让「运行时不存在」自愈。别再靠正则匹配文案判断。
    error.retryable = false;
    throw error;
  }
  const entry = ensured.entry || findEntry(runtimeDir);

  const nodeBin = expand(config.nodeBin || '') || findNode();
  const host = config.upstreamHost || '127.0.0.1';
  const port = await pickPort(config.upstreamPort, host);
  const workspace = expand(config.workspaceDir || '') || resolve(homedir(), 'dsh-editor-mode');

  // 独立 user-data-dir：不污染用户全局 code-server 配置，也让默认设置可复现。
  const userDataDir = expand(config.userDataDir || '') || join(homedir(), '.dsh', 'editor-runtime', 'user-data');
  ensureEditorSettings(userDataDir, config);

  const args = [
    entry,
    '--bind-addr', `${host}:${port}`,
    '--auth', 'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--trusted-origins', '*',
    '--extensions-dir', join(PACKAGE_DIR, 'extensions'),
    '--user-data-dir', userDataDir,
    workspace,
  ];

  // 把桥接参数通过环境传给 code-server 的扩展主机（扩展用 process.env 读取）。
  // URL 指向 DSH 自身的 /editor-bridge/push 与 /editor-sessions/*，不是 code-server 自身。
  const env = {
    ...process.env,
    FORCE_NODE_VERSION: '24',
    DSH_BRIDGE_TOKEN: bridge?.token || '',
    DSH_BRIDGE_URL: bridge?.pushUrl || '',
    // 编辑器内 Chat 用的基址 + token；留空时扩展会回退读 runtimeDir/bridge.json。
    DSH_EDITOR_BASE: bridge?.base || '',
    DSH_EDITOR_TOKEN: bridge?.token || '',
    // 让 VS Code 完全不加载指定内置扩展。
    //
    // 为什么不是写 settings.json：code-server 发行包内置 GitHub Copilot Chat
    // （product.json 的 builtInExtensionsEnabledWithAutoUpdates），它不属于 user
    // 扩展，`github.copilot.enable:false` 只关掉补全，右侧 Chat 视图照样注册，
    // 用户就会看到一个要登录 GitHub 的面板 —— 与 DSH 的模型配置毫无关系。
    //
    // 内置扩展只能靠这个环境变量跳过（server-main.js 的 scanSystemExtensions 读取
    // environmentService.skipBuiltinExtensions），code-server 的 CLI 不转发
    // `--disable-extension`。设置后 VS Code 内部会把该扩展标记为「已禁用」，
    // 正好符合「用 DSH Chat 替换掉它」的预期。
    VSCODE_SKIP_BUILTIN_EXTENSIONS: (config.skipBuiltinExtensions ?? ['GitHub.copilot-chat']).join(','),
  };
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
    // 进程已退出就没必要再等满 20 秒 —— 那会让崩溃重启白等一轮。
    if (child.exitCode !== null || child.signalCode !== null) return false;
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

/**
 * 本机服务自身的基址。DSH 只暴露 host/port 两个 getter（没有 getOrigin），
 * 监听 0.0.0.0 时回环访问要用 127.0.0.1。拿不到端口时返回空串，调用方降级。
 */
function selfBase(webServer) {
  const host = webServer?.host === '0.0.0.0' ? '127.0.0.1' : (webServer?.host || '127.0.0.1');
  const port = Number(webServer?.port) || 0;
  return port ? `http://${host}:${port}` : '';
}

/**
 * 把 {base, token} 落到运行时目录：扩展主机在 DSH 重启、env 丢失时按此文件兜底。
 *
 * 多实例安全：同一个 runtimeDir 可能被多个 DSH 实例共用（例如开发时并排跑一个
 * 测试实例），无条件写入会让**后启动的覆盖先启动的**，导致扩展把请求发到别的实例。
 * 因此写入前先探活：文件里记录的 base 若仍可达就放弃覆盖（让出给运行中的实例）。
 *
 * @param runtimeDir 运行时目录
 * @param info {{ base: string, token: string, updatedAt: number }}
 * @returns 实际生效的桥接文件路径；写入失败或让出时为空串
 */
async function writeBridgeFile(runtimeDir, info) {
  try {
    mkdirSync(runtimeDir, { recursive: true });
    const file = join(runtimeDir, 'bridge.json');
    const owner = await readLiveBridgeOwner(file);
    // 已有别的实例在跑且可达：不覆盖，避免把扩展指向错的地方。
    if (owner && owner.base && owner.base !== info.base) return '';
    writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    return file;
  } catch {
    return '';
  }
}

/**
 * 读现有 bridge.json 并探活。
 * 只要目标端口有 HTTP 应答（含 401）就认为那个实例还活着。
 * @param file bridge.json 路径
 * @returns 仍然存活的记录；不存在或已失效返回 null
 */
async function readLiveBridgeOwner(file) {
  let prev;
  try {
    prev = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!prev?.base) return null;
  try {
    await fetch(`${prev.base}/editor-status`, { signal: AbortSignal.timeout(800) });
    return prev;
  } catch {
    return null;
  }
}

/** 只接受回环来源：编辑器扩展跑在本机 code-server 的扩展主机里。 */
function loopbackOnly(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 从请求头或查询串取 token（GET 用头，便于 SSE 前的普通 fetch 复用同一份代码）。 */
function tokenFromRequest(req, url) {
  const header = req.headers['x-dsh-editor-token'];
  if (typeof header === 'string' && header) return header;
  return url.searchParams.get('token') || '';
}

/** 读一个受长度限制的 JSON 请求体；超限返回 null 并由调用方回 413。 */
async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return { tooLarge: true };
    chunks.push(chunk);
  }
  if (!chunks.length) return { value: {} };
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { invalid: true };
  }
}

/**
 * 一个极小的 SSE 写出器。
 * 用 SSE 而不是 WebSocket：扩展主机是 Node（无 DOM），SSE 用普通 http 请求即可，
 * 失败可重试，且不需要 DSH 侧再维护一条长连接路由。
 */
function sseWriter(res) {
  let closed = false;
  res.on('close', () => { closed = true; });
  const write = (event, data) => {
    if (closed || res.writableEnded) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { closed = true; }
  };
  return { write, get closed() { return closed; } };
}

/**
 * 本插件依赖的服务。
 *
 * 关键：不能只在 apply() 里 ctx.get('webServer') 然后 throw。
 * cordis 按拓扑顺序解析服务，插件行可能早于 `webserver` 行求值；一旦 apply
 * 同步抛错，这一行会**永久不激活**且不会重试，表现为 DSH 正常但所有
 * /editor* 路由 404（桌面端还会把这条错误吞进 stderr，用户完全看不到）。
 *
 * 声明式依赖让 cordis 等到服务就绪后再执行 apply，顺序由它保证。
 */
export const inject = ['webServer'];

/**
 * 兜底：即便运行时不按 inject 等待（例如老版本 loader 忽略该字段），
 * 也改成「延迟重试」而不是抛错，避免静默失效。
 */
function whenWebServer(ctx, run, attempts = 40, delayMs = 250) {
  const ready = ctx.get('webServer');
  if (ready) { run(ready); return () => {}; }

  let off = () => {};
  try {
    // cordis 的服务就绪事件；不同版本名称不同，都试一遍。
    off = ctx.on('internal/service', (name) => {
      if (name !== 'webServer') return;
      const svc = ctx.get('webServer');
      if (!svc) return;
      off();
      off = () => {};
      run(svc);
    }) || (() => {});
  } catch { off = () => {}; }

  // 轮询兜底：覆盖不派发事件的情形；有次数上限，不会无限占用定时器。
  let left = attempts;
  const timer = setInterval(() => {
    left -= 1;
    const svc = ctx.get('webServer');
    if (svc) {
      clearInterval(timer);
      off();
      off = () => {};
      run(svc);
      return;
    }
    if (left <= 0) {
      clearInterval(timer);
      ctx.logger?.warn?.('[editor-mode] webServer 未就绪，编辑器后端未启动（请在 DSH 设置中确认 webserver 插件已启用）');
    }
  }, delayMs);
  timer.unref?.();

  return () => { clearInterval(timer); off(); };
}

/**
 * 配置规格：声明每一项的类型与取值约束。
 *
 * 为什么不用 schemastery：`@deepseek-ai/schemastery` 只存在于 DSH 应用的顶层
 * node_modules，而本插件是从 profile（软链到仓库）加载的，模块解析走不到那里。
 * 依赖它会让插件在加载阶段直接崩掉——比缺少 schema 严重得多。
 * 所以这里用零依赖的小表 + 校验器，达到同样的目的：早期、可读、可测。
 */
const CONFIG_SPEC = {
  // 注意：目录「存在与否」是运行时状态（首次使用还没装运行时），
  // 不是配置错误——判成致命错误会让「未安装 → 给安装指引」这条正常路径变成启动崩溃。
  runtimeDir: { kind: 'path', optional: true, hint: 'code-server 运行时目录（默认 ~/.dsh/editor-runtime）' },
  // 自动下载用：只接受 https + 必须带 SHA-256，缺席即拒绝（见 ensureRuntime）
  runtimeSource: { kind: 'httpsUrl', optional: true, hint: 'code-server 发行包 URL（首次启动自动下载）' },
  runtimeSha256: { kind: 'sha256', optional: true, hint: '上述发行包的 SHA-256' },
  userDataDir: { kind: 'path', optional: true, hint: 'code-server 用户数据目录' },
  workspaceDir: { kind: 'path', optional: true, hint: '打开的项目目录' },
  upstreamHost: { kind: 'bindHost', default: '127.0.0.1', hint: 'code-server 监听地址' },
  upstreamPort: { kind: 'port', default: 3999, hint: 'code-server 监听端口' },
  nodeBin: { kind: 'exec', optional: true, hint: '启动 code-server 的 node 可执行文件' },
  skipBuiltinExtensions: {
    kind: 'extensionIds', default: ['GitHub.copilot-chat'], hint: '要跳过的内置扩展',
  },
  bridgeToken: { kind: 'token', optional: true, hint: '编辑器桥接固定 token' },
  editorSettings: { kind: 'plainObject', optional: true, hint: '写进 VS Code 的设置' },
};

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 校验插件配置，返回 `{ value, errors, warnings }`。
 *
 * 非法项不会抛第一个就停：一次把全部问题列出来，用户改一轮就能过，
 * 而不是「改一个、重启一次、再报下一个」。
 *
 * errors 会阻止插件启动；warnings 只记录，不改变原有可用行为
 * （把「弱 token」这类可改进项判成致命错误，会让原本能跑的配置突然起不来）。
 *
 * @param {Record<string, unknown>} input 原始配置
 * @returns {{value: Record<string, unknown>, errors: string[], warnings: string[]}}
 */
export function validateConfig(input = {}) {
  const errors = [];
  const warnings = [];
  const value = {};
  if (!isPlainObject(input)) {
    return { value: {}, errors: ['配置必须是对象'], warnings };
  }

  for (const [name, rule] of Object.entries(CONFIG_SPEC)) {
    const raw = input[name];
    const isUnset = raw === undefined || raw === null || raw === '';
    if (isUnset) {
      if (!rule.optional) value[name] = rule.default;
      continue;
    }

    switch (rule.kind) {
      case 'port': {
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push(`${name}: 必须是 1..65535 的整数，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
        } else {
          value[name] = port;
        }
        break;
      }
      case 'bindHost': {
        const host = String(raw);
        if (!host.trim() || /[\s/]/.test(host) || host.includes('://')) {
          errors.push(`${name}: 必须是不带协议与路径的主机名/IP，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
        } else {
          value[name] = host;
        }
        break;
      }
      case 'exec': {
        // 同样要看原始输入：expand() 会把相对路径 resolve 成绝对，判不出来
        const input = String(raw);
        if (!isAbsolute(input) && !input.startsWith('~')) {
          errors.push(`${name}: 需要绝对路径或 ~ 开头，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
          break;
        }
        const bin = expand(input);
        value[name] = input;
        // 不可执行只告警：运行时可能还没装，那是状态问题不是配置笔误。
        try {
          accessSync(bin, constants.X_OK);
        } catch {
          warnings.push(`${name}: 当前不可执行（解析为 ${bin}），启动时会失败（${rule.hint}）`);
        }
        break;
      }
      case 'path': {
        // 必须检查**原始输入**：expand() 里用 resolve() 会把相对路径补成
        // 相对当前工作目录的绝对路径，结果「悄悄生效但指向别处」。
        const input = String(raw);
        if (!isAbsolute(input) && !input.startsWith('~')) {
          errors.push(`${name}: 需要绝对路径或 ~ 开头，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
        } else {
          value[name] = input;
        }
        break;
      }
      case 'extensionIds': {
        if (!Array.isArray(raw)) {
          errors.push(`${name}: 必须是字符串数组，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
          break;
        }
        const bad = raw.filter((x) => typeof x !== 'string' || !/^[^\s.]+\.[^\s.]+$/.test(x));
        if (bad.length > 0) {
          errors.push(`${name}: 每项应为 publisher.name 形式，非法项 ${JSON.stringify(bad)}（${rule.hint}）`);
        } else {
          value[name] = raw.slice();
        }
        break;
      }
      case 'token': {
        const token = String(raw);
        // 只告警不拒绝：token 仅用于回环鉴权，短了是「不够强」而非「不可用」，
        // 判成致命错误会把原本能跑的配置直接挡在启动之外。
        if (token.length < 16) {
          warnings.push(`${name}: 只有 ${token.length} 个字符，建议 16 位以上（${rule.hint}）`);
        }
        value[name] = token;
        break;
      }
      case 'httpsUrl': {
        const raw2 = String(raw);
        let parsed2 = null;
        try { parsed2 = new URL(raw2); } catch { /* 下面统一报错 */ }
        if (!parsed2 || parsed2.protocol !== 'https:') {
          errors.push(`${name}: 必须是 https URL，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
        } else {
          value[name] = raw2;
        }
        break;
      }
      case 'sha256': {
        const hex = String(raw).trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(hex)) {
          errors.push(`${name}: 必须是 64 位十六进制 SHA-256，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
        } else {
          value[name] = hex;
        }
        break;
      }
      case 'plainObject': {
        if (!isPlainObject(raw)) {
          errors.push(`${name}: 必须是对象，收到 ${JSON.stringify(raw)}（${rule.hint}）`);
        } else {
          value[name] = raw;
        }
        break;
      }
      default: {
        value[name] = raw;
      }
    }
  }

  // 未声明的键不报错（DSH 可能透传其它字段），但按原样保留给下游使用。
  for (const [key, raw] of Object.entries(input)) {
    if (!(key in CONFIG_SPEC) && raw !== undefined) value[key] = raw;
  }

  return { value, errors, warnings };
}

// ---------------------------------------------------------------------------
// 行内补全（P3-3）：独立于会话的轻量调用
// ---------------------------------------------------------------------------

/**
 * 补全请求的预算与限制。
 *
 * 为什么这些数字必须很小：补全是「打字时每几秒一次」的高频操作，
 * 一旦单次就慢或贵，用户会先感觉到卡顿、再感觉到账单。
 */
/** 服务端同时处理的补全请求上限（见 /editor-completion 的限流注释）。 */
const COMPLETION_SERVER_MAX = 2;

const COMPLETION_LIMITS = {
  maxPrefixChars: 4000,      // 上下文预算：只带光标前的有限正文
  maxSuffixChars: 1000,      // 光标后少量，帮模型知道不要重复
  maxTokens: 80,             // 补全只该给一两行
  timeoutMs: 1500,           // 超时就当没有建议，不阻塞用户
};

/**
 * 从 DSH 的 `llm` 服务取一份补全。
 *
 * 不能复用 `/editor-sessions/stream`：那条路径要经过会话、工具、权限、
 * 事件广播，秒级延迟；补全需要的是「直连模型 + 极短输出」。
 *
 * @param {object} deps { llm, provider, model }
 * @param {object} req { prefix, suffix, language, file }
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} 补全文本（失败或超时返回空串）
 */
export async function requestCompletion(deps, req, signal) {
  const { llm, provider, model } = deps;
  if (!llm?.prepareCall) return '';

  const prefix = String(req?.prefix ?? '').slice(-COMPLETION_LIMITS.maxPrefixChars);
  const suffix = String(req?.suffix ?? '').slice(0, COMPLETION_LIMITS.maxSuffixChars);
  if (!prefix.trim()) return '';

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), COMPLETION_LIMITS.timeoutMs);

  try {
    // abort 只是"请求取消"的信号，若底层根本不响应它（例如适配器网络挂起），
    // await 会永远不返回，补全请求也就永不结束。这里再做一层硬 race，
    // 保证请求方一定能在预算内拿到结果。
    const prepared = await Promise.race([
      llm.prepareCall(provider, model, controller.signal),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('prepare 超时')), COMPLETION_LIMITS.timeoutMs);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('已取消'));
        }, { once: true });
      }),
    ]);
    const messages = [{
      role: 'user',
      // 只给最少信息：文件语言 + 光标前后。给太多反而让模型去「总结」而不是续写。
      content: [
        `语言：${req?.language || '未知'}；文件：${req?.file || '未命名'}`,
        '请在光标处续写代码，只输出要插入的内容本身（不要解释、不要重复已有代码、不要代码块标记）。',
        '<cursor_before>',
        prefix,
        '</cursor_before>',
        '<cursor_after>',
        suffix,
        '</cursor_after>',
      ].join('\n'),
    }];

    let text = '';
    const stream = prepared.stream({
      messages,
      maxTokens: COMPLETION_LIMITS.maxTokens,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      const delta = chunk?.delta?.text ?? chunk?.text ?? '';
      if (delta) text += delta;
      if (text.length > 400) break;   // 防止模型无视 maxTokens 长篇输出
    }
    return cleanCompletion(text, prefix, suffix);
  } catch {
    // 补全失败必须静默：任何一次报错弹窗都会打断用户打字
    return '';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * 清洗模型输出：去掉代码块围栏、重复的前缀、以及明显不是续写的内容。
 *
 * 模型常见坏习惯（不清理会直接显示成幽灵文本）：
 *   - 把整个代码块用 ``` 包起来
 *   - 从头重抄上一行
 *   - 直接输出文件剩余部分
 */
export function cleanCompletion(raw, prefix, suffix) {
  let text = String(raw ?? '');
  // 去掉 ```lang ... ``` 围栏
  text = text.replace(/^\s*```[a-zA-Z0-9-]*\n?/, '').replace(/\n?```\s*$/, '');
  // 去掉与光标前内容重复的尾巴（模型常重抄最后一行）
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lastLine && text.startsWith(lastLine)) text = text.slice(lastLine.length);
  // 如果模型把光标后的内容也吐出来了，截掉
  if (suffix) {
    const at = text.indexOf(suffix.slice(0, Math.min(20, suffix.length)));
    if (at > 0) text = text.slice(0, at);
  }
  return text.replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// 本地代码检索（P4-1）：关键词版
// ---------------------------------------------------------------------------

/** 检索限制：把单次搜索的代价框住，避免一次查询把整棵树吐出来。 */
const SEARCH_LIMITS = {
  maxResults: 200,
  maxFileBytes: 1024 * 1024,   // 单文件上限，跳过压缩产物 / 数据文件
  timeoutMs: 8000,
  maxPatternChars: 200,
};

/** 命中一行时保留的最大字符数，避免压缩过的单行文件撑爆响应。 */
const SEARCH_LINE_MAX = 240;

/**
 * 用 ripgrep 在工作区内做关键词检索。
 *
 * 为什么用 rg 而不是自己遍历：rg 默认就跳过 `.gitignore` 里的文件和二进制，
 * 这正好是我们想要的语义；自己实现要重写一遍 ignore 规则，容易搜出依赖目录。
 *
 * 安全边界：
 *   - 只在 root 内搜（rg 的 cwd 就是 root，不接受任意路径参数）
 *   - 不把任何结果发往外部 —— 这是"代码不上云"的硬要求
 *   - 固定参数、不经 shell（`spawn` 传数组），避免命令注入
 *
 * @param {object} opts { root, pattern, glob, ignoreCase, maxResults }
 * @returns {Promise<{lines: Array, truncated: boolean, total: number}>}
 */
export async function searchCode(opts = {}) {
  const root = String(opts.root || '');
  const pattern = String(opts.pattern || '');
  if (!root || !pattern.trim()) return { lines: [], truncated: false, total: 0 };
  // 关键词检索，不是正则：把用户输入当字面量，避免 `(` 之类导致 rg 报错
  if (pattern.length > SEARCH_LIMITS.maxPatternChars) {
    return { lines: [], truncated: false, total: 0, error: 'pattern-too-long' };
  }

  const maxResults = Math.min(Number(opts.maxResults) || SEARCH_LIMITS.maxResults, SEARCH_LIMITS.maxResults);
  const args = [
    '--json',
    '--fixed-strings',            // 字面量匹配：用户搜 `foo(` 不该被当正则
    '--max-filesize', String(SEARCH_LIMITS.maxFileBytes),
    '--max-count', String(maxResults),
    '-n',
    // 注意：不能指望 rg 自动跳过依赖目录。它的 ignore 规则依赖 .git 上下文，
    // 工作区不是 git 仓库（或临时目录）时会照样搜进 node_modules —— 实测踩到过。
    // 因此显式排除；--no-ignore-vcs 保证用户的 .gitignore 仍被遵守的情况下
    // 我们额外排掉构建产物与依赖。
    '--glob', '!node_modules/**',
    '--glob', '!.git/**',
    '--glob', '!dist/**',
    '--glob', '!build/**',
    '--glob', '!out/**',
    '--glob', '!coverage/**',
    // 同上：工作区没有 .git 时 rg 默认不读 .gitignore，会让被用户显式忽略的
    // 文件（日志、密钥导出、临时产物）混进检索结果。开启后两条规则都生效。
    '--no-require-git',
  ];
  if (opts.ignoreCase) args.push('--ignore-case');
  if (opts.glob) args.push('--glob', String(opts.glob));
  args.push('--', pattern);

  return new Promise((resolveSearch) => {
    const child = spawn(rgPath(), args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    let stderr = '';
    let truncated = false;

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, SEARCH_LIMITS.timeoutMs);
    timer?.unref?.();

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.type !== 'match') continue;
        const path = msg.data?.path?.text || '';
        const lineNo = msg.data?.line_number || 0;
        const text = (msg.data?.lines?.text || '').replace(/\s+$/, '');
        if (lines.length >= maxResults) { truncated = true; continue; }
        lines.push({
          path,
          line: lineNo,
          text: text.length > SEARCH_LINE_MAX ? `${text.slice(0, SEARCH_LINE_MAX)}…` : text,
        });
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveSearch({ lines: [], truncated: false, total: 0, error: String(err?.message || err) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // rg 的 1 = 没有匹配，属正常；2 = 出错
      const error = code === 2 ? (stderr.trim().slice(0, 300) || 'rg 失败') : '';
      resolveSearch({ lines, truncated, total: lines.length, ...(error ? { error } : {}) });
    });
  });
}

/**
 * 把请求里的 root 限定在工作区内。
 *
 * 为什么必须限：`body.root` 是调用方给的，若不校验，任何持 token 的本地进程
 * 都能把 root 指到家目录甚至 `/`，把日志、`.env`、SSH 密钥内容检索出来
 * （实测：指到 $HOME 能搜到应用日志）。检索端口不该成为任意文件读取器。
 *
 * 判定要求**目录边界**：`/work/repo-other` 不属于 `/work/repo`。
 *
 * @param {string} requested 调用方请求的目录（可能为空）
 * @param {string} workspace 允许的根
 * @returns {{root: string, error?: string}}
 */
export function confineRoot(requested, workspace) {
  const ws = expand(String(workspace || ''));
  if (!ws) return { root: '', error: 'no-workspace' };
  const want = requested ? expand(String(requested)) : ws;
  if (!want) return { root: '', error: 'invalid-root' };

  const wsPrefix = ws.endsWith('/') ? ws : `${ws}/`;
  if (want === ws || want.startsWith(wsPrefix)) return { root: want };
  return { root: '', error: 'root-outside-workspace' };
}

/** 优先用 DSH 自带的 rg，其次系统 PATH 里的。 *//** 优先用 DSH 自带的 rg，其次系统 PATH 里的。 */
function rgPath() {
  const bundled = join(PACKAGE_DIR, '..');
  const candidates = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
    join(bundled, 'node_modules', '.bin', 'rg'),
  ];
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return c; } catch { /* 继续找 */ }
  }
  return 'rg';   // 回落到 PATH
}

// ---------------------------------------------------------------------------
export function apply(ctx, rawConfig = {}) {
  // 启动即校验：非法配置在这里一次性报全，不要留到 spawn 阶段变成白屏。
  const { value: config, errors, warnings } = validateConfig(rawConfig);
  for (const w of warnings) ctx.logger?.warn?.(`[editor-mode] 配置提醒 — ${w}`);
  if (errors.length > 0) {
    const detail = errors.map((e) => `  - ${e}`).join('\n');
    const message = `editor-mode: 配置有 ${errors.length} 处问题，插件未启动：\n${detail}`;
    // 留一份面包屑（日志/测试用）。注意此刻还没注册任何路由，/editor-status
    // 不可能读到它；配置错误的可见渠道是下面这条 throw 造成的插件激活失败。
    apply.lastConfigError = message;
    throw new Error(message);
  }
  apply.lastConfigError = '';

  // 服务就绪后再装配；拿不到时延迟重试而不是抛错（见 whenWebServer 注释）。
  const stopWaiting = whenWebServer(ctx, (webServer) => {
    // installEditor 现在是 async（桥接文件探活需要网络往返）；失败不能让整行崩掉。
    void installEditor(ctx, config, webServer).catch((err) => {
      ctx.logger?.warn?.(`[editor-mode] 装配失败：${String(err?.message || err)}`);
    });
  });
  ctx.effect(() => () => stopWaiting());
}

/**
 * 真正的装配：只在 webServer 已就绪时调用。
 * 与 apply 分开是因为 apply 可能在服务就绪前被调用（时序问题见 whenWebServer）。
 * @param ctx 插件上下文
 * @param config 插件 config（cordis.patch.yml 的 editor-mode.config）
 * @param webServer @deepseek-ai/dsh-host-webserver 服务实例
 */
async function installEditor(ctx, config, webServer) {

  const state0 = {
    status: 'starting', upstream: '', workspace: '', log: '',
    error: '', restarts: 0, nextRetryMs: 0,
  };
  let runtime = null;

  // 「编辑器 → DSH Agents」选区桥：有界队列，避免无限堆积。
  // VS Code 扩展（Node 扩展主机）POST 进来，Client 轮询取走。
  const bridgeQueue = [];
  const BRIDGE_MAX = 20;
  const BRIDGE_TEXT_MAX = 8000;
  // 默认每次启动随机；config.bridgeToken 可注入固定值（便于测试/多实例共享）。
  const bridgeToken = config.bridgeToken
    || process.env.DSH_EDITOR_BRIDGE_TOKEN
    || randomBytes(16).toString('hex');

  // 本机基址：扩展主机用它回调 DSH 的桥接与 Chat 端点。
  const base = selfBase(webServer);
  // 落一份到运行时目录：DSH 重启后扩展主机按 env → 文件的顺序回退，避免静默失效。
  // 若已有其它实例占用且可达，这里不覆盖（多实例并存时不抢通道）。
  const bridgeFile = await writeBridgeFile(
    expand(config.runtimeDir || '~/.dsh/editor-runtime'),
    { base, token: bridgeToken, updatedAt: Date.now() },
  );

  /** 只接受回环请求：扩展跑在本机 code-server 扩展主机里。 */
  const bridgeAllowed = (req) => {
    const addr = req.socket?.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  };

  // 以 status 端点暴露 PoC 状态，便于验证与排障。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/editor-status',
    handler: (req, res) => {
      if (rejected(ctx, req, res)) return;
      // 端口/工作目录来自上游实例，状态（starting/ready/degraded/restarting/failed）
      // 来自汇总状态 state0 —— 崩溃重启时必须反映「正在重试」而不是旧的 degraded。
      const s = runtime?.state ?? {};
      // 注意：配置非法时 apply() 会在注册本路由**之前**抛错，路由根本不存在，
      // 所以这里读不到任何配置错误。配置问题的可见渠道是那条 throw 触发的
      // 插件激活失败（DSH 日志里可见 `editor-mode: 配置有 N 处问题…`）。
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        status: state0.status,
        error: state0.error,
        pid: runtime?.dead ? undefined : s.pid,
        upstream: s.upstream || state0.upstream || '',
        workspace: s.workspace || '',
        // Client 用它拼 ?folder=，让 code-server 打开插件配置的项目目录。
        folder: s.workspace || '',
        // 排障用：Chat 是否可用、桥接信息落在哪、重启了几次。
        // 会话桥是否可用（编辑器 Chat 依赖 sessionController）
        sessions: Boolean(ctx.get('sessionController')),
        bridgeFile,
        error: state0.error || '',
        restarts: state0.restarts ?? 0,
        nextRetryMs: state0.nextRetryMs ?? 0,
        log: (s.log || '').slice(-4000),
      }));
    },
  }), 'editor-mode: GET /editor-status');

  // 扩展 → Host：提交选区。用 token 防止同机其它进程随意注入。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/editor-bridge/push',
    handler: async (req, res) => {
      if (!bridgeAllowed(req)) { res.writeHead(403); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      try {
        const chunks = [];
        for await (const c of req) {
          chunks.push(c);
          if (chunks.reduce((n, b) => n + b.length, 0) > BRIDGE_TEXT_MAX * 2) {
            res.writeHead(413); res.end(); return;
          }
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body?.token !== bridgeToken) { res.writeHead(401); res.end(); return; }
        const text = String(body.text ?? '').slice(0, BRIDGE_TEXT_MAX);
        if (text.trim()) {
          bridgeQueue.push({
            file: String(body.file ?? '').slice(0, 500),
            line: Number(body.line) || 0,
            text,
            at: Date.now(),
          });
          if (bridgeQueue.length > BRIDGE_MAX) bridgeQueue.shift();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400); res.end();
      }
    },
  }), 'editor-mode: POST /editor-bridge/push');

  // Client → Host：轮询并清空待发送选区（同源，走常规鉴权）。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/editor-bridge/pending',
    handler: (req, res) => {
      if (rejected(ctx, req, res)) return;
      const items = bridgeQueue.splice(0, bridgeQueue.length);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ items }));
    },
  }), 'editor-mode: GET /editor-bridge/pending');

  // ---- 编辑器侧栏 Chat：DSH 会话桥 ----
  // 编辑器里的 Chat 就是 DSH 真实 Agent 会话的第二个视图（双模式 X），
  // 所以这里不再有「自己调 llm」的通路 —— 旧 /editor-chat/* 已整体删除。
  // 能力（工具调用、文件改动、权限、历史）全部来自 sessionController。
  const disposeSessions = registerSessionRoutes({
    ctx, webServer, token: bridgeToken, deps: { loopbackOnly, tokenFromRequest, readJsonBody, sseWriter },
  });
  ctx.effect(() => () => disposeSessions());

  // 调模型的并发池：补全与 NES 共用。
  // 必须在两个 handler 之前声明 —— 虽然闭包实际执行时已初始化，
  // 但把"能用"寄托在求值顺序上太脆弱，读代码的人也无从判断。
  let completionInflight = 0;

  // ---- 本地代码检索端点 ----
  // 只在本机工作区内跑 rg，结果不落盘、不上传：代码不外发是硬要求。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/editor-search',
    handler: async (req, res) => {
      if (!bridgeAllowed(req)) { res.writeHead(403); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      const read = await readJsonBody(req, 64 * 1024);
      if (read.tooLarge) { res.writeHead(413); res.end(); return; }
      const body = read.value || {};
      const workspace = config.workspaceDir
        ? expand(String(config.workspaceDir))
        : resolve(homedir(), 'dsh-editor-mode');
      // root 必须落在工作区内：否则检索端口就成了任意文件读取器
      const confined = confineRoot(body.root, workspace);
      if (!confined.root) {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: '只能检索工作区内的路径', reason: confined.error }));
        return;
      }
      const result = await searchCode({ ...body, root: confined.root });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(result));
    },
  }), 'editor-mode: POST /editor-search');

  // ---- 行内补全端点 ----
  // 独立于会话流：补全是毫秒级需求，走 /editor-sessions/stream 会慢一个数量级。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/editor-completion',
    handler: async (req, res) => {
      if (!bridgeAllowed(req)) { res.writeHead(403); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      const read = await readJsonBody(req, 256 * 1024);
      if (read.tooLarge) { res.writeHead(413); res.end(); return; }
      if (read.invalid) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
        return;
      }
      const body = read.value || {};
      const llm = ctx.get('llm');
      if (!llm?.prepareCall) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'DSH 未提供 llm 服务，补全不可用' }));
        return;
      }
      // 用当前默认模型；拿不到就当没有补全，不要报错打断用户
      let provider = body?.provider || '';
      let model = body?.model || '';
      try {
        if (!provider || !model) {
          const def = ctx.get('defaultModel')?.get?.();
          provider = provider || def?.provider || '';
          model = model || def?.model || '';
        }
      } catch { /* 忽略 */ }
      if (!provider || !model) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ text: '', reason: 'no-model' }));
        return;
      }

      // 服务端也要限流：补全在打字时是高频调用，客户端节流不能当成保证
      // （任何持 token 的本地进程都能直接打这个端点）。超限直接返回空建议，
      // 让用户那边表现为"暂时没补全"，而不是把模型配额打光。
      if (completionInflight >= COMPLETION_SERVER_MAX) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ text: '', reason: 'busy' }));
        return;
      }

      const controller = new AbortController();
      req.on('close', () => controller.abort());
      completionInflight += 1;
      let text = '';
      try {
        text = await requestCompletion({ llm, provider, model }, body, controller.signal);
      } finally {
        completionInflight -= 1;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ text }));
    },
  }), 'editor-mode: POST /editor-completion');

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

  // ---- 崩溃自动重启 ----
  // code-server 会因为内存峰值、扩展主机崩溃、端口被抢等原因退出。没有这层兜底时，
  // 用户看到的是「编辑器突然白屏，必须重启 DSH」。这里按指数退避重拉，并给上限，
  // 避免真正的配置错误（比如运行时缺失）导致无限重启风暴。
  const MAX_RESTARTS = 5;
  let restarts = 0;          // 已重试次数（成功后归零）
  let restartTimer = null;
  let stopping = false;      // 卸载中：不再重启

  void 0;
  /** 启动（或重启）上游，并安排下一次重试。 */
  const boot = async () => {
    if (stopping) return;
    try {
      const pushUrl = base ? `${base}/editor-bridge/push` : '';
      const started = await startServer(config, ctx, { token: bridgeToken, pushUrl, base });
      runtime = started;
      state0.status = 'starting';
      state0.error = '';
      state0.upstream = started.state.upstream;
      // 进程退出 → 走统一的重启路径（正常卸载时的 stop 会置 stopping 屏蔽它）。
      // 用闭包捕获这一轮的 child，避免重试后旧进程的 exit 事件误伤新进程。
      const { child } = started;
      child.on('exit', (code, signal) => {
        if (stopping) return;
        if (runtime?.child !== child) return; // 已经是新一轮了，忽略旧事件
        runtime = { ...started, dead: true };
        scheduleRestart(`code-server 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
      });
      const ok = await waitReady(started.state, child);
      if (ok) {
        restarts = 0;               // 真正就绪才清零，避免「起来就崩」被当成成功
        started.state.status = 'ready';
      } else {
        started.state.status = 'degraded';
        scheduleRestart('code-server 起来了但工作台没有就绪');
      }
      ctx.logger?.info?.(`[editor-mode] code-server ${started.state.status} at ${started.state.upstream}`);
    } catch (err) {
      state0.status = 'failed';
      state0.error = String(err?.message || err);
      state0.log = String(err?.stack || err);
      ctx.logger?.warn?.(`[editor-mode] 启动失败：${state0.log}`);
      // 运行时缺失 / 配置非法不会因为重试自愈，只提示不重试。
      // 优先看显式标记（err.retryable === false）；正则只作为历史文案的兜底。
      if (err?.retryable === false || /未安装/.test(state0.error)) return;
      scheduleRestart(state0.error);
    }
  };

  /** 安排一次重试；超过上限就停在 failed 状态并说明原因。 */
  function scheduleRestart(reason) {
    if (stopping || restartTimer) return;
    if (restarts >= MAX_RESTARTS) {
      state0.status = 'failed';
      state0.error = `${reason}；已重试 ${restarts} 次仍失败，停止自动重启`;
      ctx.logger?.warn?.(`[editor-mode] ${state0.error}`);
      return;
    }
    restarts += 1;
    const delay = backoffMs(restarts);
    state0.status = 'restarting';
    state0.error = reason;
    state0.restarts = restarts;
    state0.nextRetryMs = delay;
    ctx.logger?.info?.(`[editor-mode] ${reason}；${delay}ms 后第 ${restarts}/${MAX_RESTARTS} 次重启`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void boot();
    }, delay);
    restartTimer.unref?.();
  }

  // 卸载时终止整组子进程（含其派生的扩展主机 / PTY），并释放路由。
  // 用独立进程组的负 pid，避免主进程退出后留下无法回收的孤儿。
  ctx.effect(() => {
    const stop = () => {
      stopping = true; // 先屏蔽自动重启，否则 SIGTERM 会被当成崩溃又拉起来
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
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
  // 首启。失败会走 scheduleRestart 自动重试（配置类故障除外）。
  void boot();

  return { state: state0, getRuntime: () => runtime };
}

/**
 * 仅供测试与排障使用的内部出口（不是对外 API）。
 * 这些纯函数不做 I/O，单独测试能覆盖掉 Chat 的消息组装/上下文注入逻辑。
 */
export const __internals = {
  backoffMs,
  selfBase,
  loopbackOnly,
};
