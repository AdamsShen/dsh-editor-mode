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
 *  5. 编辑器内 Chat 的后端：/editor-chat/{models,send,abort}，直接走 ctx.llm，
 *     复用用户在 DSH 里配置的模型与凭据（不新增任何模型配置）。
 *
 * 边界（当前阶段有意不做）：
 *  - 不自带运行时下载/校验，使用 config.runtimeDir 指向已安装目录；
 *  - 不做多实例复用、崩溃自动重启、优雅停机之外的清理；
 *  - 编辑器内 Chat 是「纯模型对话」，不给模型任何工具（不读文件、不执行命令）。
 *    需要真正动手改代码时，走「发送到 Agents」交回 DSH Agent。
 */

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/** 本插件包目录（用于定位随包发布的 VS Code 扩展）。 */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

const EDITOR_PREFIX = '/editor/';
const EDITOR_WS_PATH = '/editor/';

/** 编辑器内 Chat 的三个端点（均为回环 + token，供 code-server 扩展主机调用）。 */
const CHAT_MODELS_PATH = '/editor-chat/models';
const CHAT_SEND_PATH = '/editor-chat/send';
const CHAT_ABORT_PATH = '/editor-chat/abort';
const CHAT_BODY_MAX = 512 * 1024;
/** 送给模型的历史上限：消息条数。超出时从最旧的开始丢，保留最近上下文。 */
const CHAT_MAX_MESSAGES = 40;
/** 单条选区注入正文上限，避免把整个大文件塞进 prompt。 */
const CHAT_CONTEXT_MAX = 12000;

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

/**
 * 启动 code-server。返回 { child, state }；失败时抛错，由 apply 转成可展示的状态。
 * 说明：本机 DSH 自带 node 带 hardened runtime，会拒绝加载 argon2 的第三方签名原生模块，
 * 因此固定用系统 node + FORCE_NODE_VERSION=24 绕过版本门禁（已实测可启动）。
 * 生产版应改自带兼容 node 或重签原生模块。
 */
async function startServer(config, ctx, bridge) {
  const runtimeDir = expand(config.runtimeDir || '~/.dsh/editor-runtime');
  const entry = findEntry(runtimeDir);
  if (!entry) {
    // 这是唯一需要用户动手的失败，说清楚怎么做，别让它变成一块白屏。
    throw new Error(
      `code-server 未安装：在 ${runtimeDir} 下找不到 out/node/entry.js。`
      + ` 安装：mkdir -p ${runtimeDir} && cd ${runtimeDir} && npm init -y && `
      + 'FORCE_NODE_VERSION=24 npm install code-server@4.145.2',
    );
  }

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
  // URL 指向 DSH 自身的 /editor-bridge/push 与 /editor-chat/*，不是 code-server 自身。
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
 * 列出「DSH 里当前可用的模型」。
 *
 * 只读 llm 适配器注册表 + agentDefaultModel 的当前选择，不读任何插件私有配置，
 * 因此编辑器里看到的就是用户在 DSH 设置里配好的那套（含自定义 provider）。
 */
async function describeModels(ctx) {
  const llm = ctx.get('llm');
  if (!llm) return { default: null, providers: [], error: '当前 DSH 未挂载 llm 服务' };

  let infos = [];
  try { infos = llm.listProviders() || []; } catch { infos = []; }

  const providers = [];
  for (const p of infos) {
    const entry = { id: p.id, name: p.name || p.id, models: [] };
    try {
      const list = await llm.listModels(p.id);
      entry.models = (list || []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m?.context?.contextWindow ?? null,
      }));
    } catch { /* 该 provider 目录不可用时只暴露 provider 本身 */ }
    providers.push(entry);
  }

  // 默认值优先取用户在 DSH 里选定的模型；取不到再退到第一个可用模型。
  let sel = null;
  try {
    const s = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (s?.provider && s?.model) {
      sel = { provider: s.provider, model: s.model, reasoningEffort: s.reasoningEffort ?? null };
    }
  } catch { /* 未配置默认模型 */ }
  if (!sel) {
    const first = providers.find((p) => p.models.length) || providers[0];
    if (first) sel = { provider: first.id, model: first.models[0]?.id ?? '', reasoningEffort: null };
  }
  return { default: sel, providers };
}

/** 组装 system 提示：默认是「纯模型对话」的边界说明，附当前项目目录。 */
function composeSystem(base, context) {
  const fallback = [
    '你是 DSH 编辑器（内置 VS Code）里的编程助手，复用用户已在 DSH 配置的模型。',
    '回答用中文，直接、具体、可执行；涉及代码时给最小可用的片段，不要长篇铺陈。',
    '你看不到用户工作区的文件，只能依据对话里粘贴的代码与上下文作答；',
    '信息不足时明确说要哪个文件的哪一段。你无法修改文件、执行命令或访问网络，',
    '需要真正动手改动时，提示用户用「发送到 Agents」把需求交给 DSH Agent。',
  ].join('');
  const lines = [base || fallback];
  if (context?.folder) lines.push(`当前项目目录：${context.folder}`);
  return lines.join('\n\n');
}

/** 把编辑器上下文（当前文件/选区）追加到最后一条用户消息，而不是伪造额外消息。 */
function appendContext(messages, context) {
  if (!context || (!context.file && !context.text)) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;

  const parts = [];
  if (context.file) {
    parts.push(`当前文件：${context.file}${context.line ? `:${context.line}` : ''}`);
  }
  if (context.text) {
    const lang = String(context.language || '');
    parts.push(`\`\`\`${lang}\n${String(context.text).slice(0, CHAT_CONTEXT_MAX)}\n\`\`\``);
  }
  const prev = String(last.content?.[0]?.text ?? '');
  const content = [{ type: 'text', text: `${prev}\n\n【编辑器上下文】\n${parts.join('\n')}` }];
  return [...messages.slice(0, -1), {
    id: last.id, role: 'user', content, source: last.source,
  }];
}

/** 把前端朴素消息转成 llm 需要的 Message（必须带 source，adapter 会读它）。 */
function composeMessages(raw, provider, model) {
  const out = [];
  for (const m of raw) {
    const text = String(m?.content ?? '').trim();
    if (!text) continue;
    const content = [{ type: 'text', text }];
    if (m?.role === 'assistant') {
      out.push({ id: nextMessageId(), role: 'assistant', content, source: { kind: 'model', provider, model } });
    } else {
      out.push({ id: nextMessageId(), role: 'user', content, source: { kind: 'user' } });
    }
  }
  return out.slice(-CHAT_MAX_MESSAGES);
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

export function apply(ctx, config = {}) {
  // 轻量校验：config 无 schema，靠这里兜住明显错配，避免端口/路径非法时静默失败。
  const port = Number(config.upstreamPort ?? 3999);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`editor-mode: upstreamPort 必须是 1..65535，收到 ${String(config.upstreamPort)}`);
  }
  void port;

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

  // 编辑器内 Chat：进行中的请求（requestId → AbortController），用于「停止生成」。
  const chatInflight = new Map();

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
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        status: state0.status,
        pid: runtime?.dead ? undefined : s.pid,
        upstream: s.upstream || state0.upstream || '',
        workspace: s.workspace || '',
        // Client 用它拼 ?folder=，让 code-server 打开插件配置的项目目录。
        folder: s.workspace || '',
        // 排障用：Chat 是否可用、桥接信息落在哪、重启了几次。
        chat: Boolean(ctx.get('llm')),
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

  // ---- 编辑器内 Chat：模型目录 ----
  // 扩展主机启动时/切换模型前调用；返回的是 DSH 里真实注册的 provider 与模型，
  // 以及 agentDefaultModel 的当前选择（即用户在 DSH 设置里选的那个）。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: CHAT_MODELS_PATH,
    handler: async (req, res) => {
      if (!loopbackOnly(req)) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url, 'http://localhost');
      if (tokenFromRequest(req, url) !== bridgeToken) { res.writeHead(401); res.end(); return; }
      let payload;
      try {
        payload = await describeModels(ctx);
      } catch (err) {
        payload = { default: null, providers: [], error: String(err?.message || err) };
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(payload));
    },
  }), 'editor-mode: GET /editor-chat/models');

  // ---- 编辑器内 Chat：一次对话（SSE 流式） ----
  // 请求体：{ token, requestId, provider?, model?, system?, messages:[{role,content}], context? }
  // 响应：text/event-stream，事件 meta / delta / reasoning / usage / finish / error。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: CHAT_SEND_PATH,
    handler: async (req, res) => {
      if (!loopbackOnly(req)) { res.writeHead(403); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }

      const body = await readJsonBody(req, CHAT_BODY_MAX);
      if (body.tooLarge) { res.writeHead(413); res.end(); return; }
      if (body.invalid) { res.writeHead(400); res.end(); return; }
      const input = body.value || {};
      if (input.token !== bridgeToken) { res.writeHead(401); res.end(); return; }

      const llm = ctx.get('llm');
      if (!llm) { res.writeHead(503); res.end('llm 服务未挂载'); return; }

      // 模型解析：请求显式指定 → DSH 默认选择 → 第一个可用模型。
      let provider = String(input.provider || '');
      let model = String(input.model || '');
      if (!provider || !model) {
        try {
          const s = ctx.get('agentDefaultModel')?.currentSelection?.();
          if (s?.provider && s?.model) { provider = provider || s.provider; model = model || s.model; }
        } catch { /* 未配置默认模型 */ }
      }
      if (!provider || !model) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('未指定模型，且 DSH 没有默认模型配置');
        return;
      }

      const rawMessages = Array.isArray(input.messages) ? input.messages : [];
      let messages = composeMessages(rawMessages, provider, model);
      if (!messages.length) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('对话内容为空');
        return;
      }
      messages = appendContext(messages, input.context);
      const system = composeSystem(input.system, input.context);

      const requestId = String(input.requestId || `req-${Date.now().toString(36)}`);
      const ac = new AbortController();
      chatInflight.set(requestId, ac);
      // 客户端断开（扩展侧主动 abort 或进程退出）时立刻停掉上游生成，不浪费 token。
      req.on('close', () => { try { ac.abort(); } catch { /* 已结束 */ } });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const sse = sseWriter(res);
      sse.write('meta', { requestId, provider, model });

      try {
        for await (const chunk of llm.stream({
          provider, model, messages, system, signal: ac.signal,
        })) {
          if (sse.closed) break;
          switch (chunk?.type) {
            case 'text-delta':
              if (chunk.text) sse.write('delta', { text: chunk.text });
              break;
            case 'reasoning-delta':
              if (chunk.text) sse.write('reasoning', { text: chunk.text });
              break;
            case 'usage':
              sse.write('usage', chunk.usage || {});
              break;
            case 'finish':
              sse.write('finish', {
                kind: chunk.reason?.kind ?? 'stop',
                failure: chunk.reason?.failure ?? null,
              });
              break;
            default:
              // block-start / block-end / tool-call-delta：纯模型对话用不到，忽略。
              break;
          }
        }
      } catch (err) {
        sse.write('error', { message: String(err?.message || err) });
      } finally {
        chatInflight.delete(requestId);
        if (!res.writableEnded) res.end();
      }
    },
  }), 'editor-mode: POST /editor-chat/send');

  // ---- 编辑器内 Chat：停止生成 ----
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: CHAT_ABORT_PATH,
    handler: async (req, res) => {
      if (!loopbackOnly(req)) { res.writeHead(403); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
      const body = await readJsonBody(req, 8 * 1024);
      const input = body.value || {};
      if (input.token !== bridgeToken) { res.writeHead(401); res.end(); return; }
      const ac = chatInflight.get(String(input.requestId || ''));
      if (ac) { try { ac.abort(); } catch { /* 已结束 */ } }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, aborted: Boolean(ac) }));
    },
  }), 'editor-mode: POST /editor-chat/abort');

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
      // 运行时缺失 / 端口非法这类配置问题不会因为重试自愈，只提示不重试。
      if (/未安装/.test(state0.error)) return;
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
  composeSystem,
  appendContext,
  composeMessages,
  selfBase,
  loopbackOnly,
  CHAT_MAX_MESSAGES,
  CHAT_CONTEXT_MAX,
};
