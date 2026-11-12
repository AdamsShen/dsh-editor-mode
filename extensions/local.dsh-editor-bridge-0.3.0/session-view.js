/**
 * 会话视图的数据层（扩展主机，Node 侧）。
 *
 * 编辑器侧栏 Chat 在 2026-11 之后不再是「自己调模型」，而是 DSH 真实 Agent
 * 会话的第二个视图（双模式 X）。因此这里只做三件事：
 *   1. 调 Host 的 /editor-sessions/* 接口
 *   2. 把会话事件（tool/call、assistant/message、…）折叠成 UI 能直接渲染的消息
 *   3. 把实时 SSE 增量并入同一份消息模型，历史与实时共用一套折叠逻辑
 *
 * 折叠为什么必须共用：否则「刚聊完」和「重新打开这条会话」会显示成两种样子。
 */

const http = require('node:http');
const https = require('node:https');
const { createSseParser } = require('./sse.js');

/** 一次历史最多取回的轮数（Host 侧再按 maxMessages 截断）。 */
const HISTORY_PAGE = 50;
/** 单条工具结果在 UI 里的展示上限，避免一条 grep 结果撑爆 webview。 */
const TOOL_RESULT_MAX = 4000;

/**
 * 发一个 JSON 请求到 DSH。
 * @param {{base:string,token:string}} channel 通道
 * @param {'GET'|'POST'} method
 * @param {string} pathname 以 / 开头
 * @param {object} [body] POST 体
 * @param {number} [timeout]
 * @returns {Promise<{status:number,json:any,text:string}>}
 */
function request(channel, method, pathname, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const { base, token } = channel;
    if (!base || !token) { reject(new Error('DSH 通道未就绪')); return; }
    let target;
    try {
      target = new URL(pathname, base);
      if (method === 'GET') target.searchParams.set('token', token);
    } catch (e) { reject(e); return; }

    const payload = method === 'POST'
      ? Buffer.from(JSON.stringify({ ...body, token }), 'utf8')
      : null;
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method,
      headers: {
        'x-dsh-editor-token': token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * 订阅一条会话的实时流。
 * @param {{base:string,token:string}} channel 通道
 * @param {string} sessionId 会话 id
 * @param {{onEvent:(event:string,data:any)=>void, signal?:AbortSignal}} opts
 * @returns {Promise<void>} 流结束或出错时 settle
 */
function streamSession(channel, sessionId, { onEvent, signal }) {
  return new Promise((resolve, reject) => {
    const { base, token } = channel;
    if (!base || !token) { reject(new Error('DSH 通道未就绪，请从 DSH 重新打开编辑器')); return; }
    let target;
    try {
      target = new URL('/editor-sessions/stream', base);
      target.searchParams.set('sessionId', sessionId);
      target.searchParams.set('token', token);
    } catch (e) { reject(e); return; }

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'GET',
      headers: { 'x-dsh-editor-token': token, accept: 'text/event-stream' },
      // Agent 干活时可能长时间没有新帧（比如跑一个慢命令），给足空闲窗口。
      timeout: 600000,
      signal,
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          reject(new Error(`DSH 返回 ${res.statusCode}${text ? `：${text}` : ''}`));
        });
        return;
      }
      res.setEncoding('utf8');
      const parser = createSseParser(onEvent);
      res.on('data', (chunk) => { parser.push(chunk); });
      res.on('end', () => { parser.flush(); resolve(); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('会话流超时')));
    req.on('error', (err) => {
      if (err && err.name === 'AbortError') { resolve(); return; }
      reject(err);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 事件折叠：会话事件 → 可渲染消息
// ---------------------------------------------------------------------------

/** 新建一条可渲染消息。 */
function newMessage(role) {
  return { role, parts: [], reasoning: '' };
}

/**
 * 从 assistant/message 的 content 块里取文字与工具调用。
 * 块种类由 DSH 定义：text / reasoning / tool-call / image。
 * @param {any[]} content 内容块数组
 * @returns {{text:string, reasoning:string, tools:object[]}}
 */
function readBlocks(content) {
  const text = [];
  const reasoning = [];
  const tools = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text);
    else if (block.type === 'tool-call') {
      tools.push({
        callId: String(block.id || ''),
        name: String(block.name || block.toolName || '工具'),
        // 参数可能是对象也可能是已序列化字符串，统一成短字符串展示。
        summary: formatArgs(block.arguments ?? block.input),
        result: '',
        status: 'running',
      });
    }
  }
  return { text: text.join(''), reasoning: reasoning.join(''), tools };
}

/** 把工具参数压成一行摘要（UI 只显示这一行，点开看全文）。 */
function formatArgs(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args.slice(0, 300);
  try {
    const json = JSON.stringify(args);
    return json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch { return String(args).slice(0, 300); }
}

/**
 * 把一串会话事件折叠成消息列表。历史加载与实时增量共用同一套规则。
 * @param {any[]} events 会话事件（含 type / data）
 * @returns {object[]} 可渲染消息
 */
function foldEvents(events) {
  const messages = [];
  /** 当前正在累积的助手消息（tool/call 可能出现在它之后的独立事件里）。 */
  let current = null;
  /** callId → 工具卡片，便于 tool/result 回填。 */
  const toolIndex = new Map();

  const push = (msg) => { messages.push(msg); return msg; };
  const ensureAssistant = () => {
    if (current && current.role === 'assistant') return current;
    current = push(newMessage('assistant'));
    return current;
  };

  for (const event of Array.isArray(events) ? events : []) {
    const type = String(event?.type || '');
    const data = event?.data || {};

    if (type === 'user/message') {
      // DSH 会把「运行时上下文 / 技能目录 / 时间快照」也作为 user/message 写进
      // 会话日志（source.kind 为 runtime-context / skill-catalog / time-context）。
      // 这些是给模型看的，渲染出来会让界面全是噪音，只保留真人输入。
      if (String(data.source?.kind || '') !== 'user') continue;
      // 实测（DSH 0.2.2-rc.1）：user/message 的内容直接在 data.content，
      // 而 assistant/message 包在 data.message.content —— 两者形状不同，
      // 统一按 data.message?.content 读会让用户消息变成空串。
      const blocks = readBlocks(data.content ?? data.message?.content);
      current = null;
      push({ role: 'user', parts: [{ type: 'text', text: blocks.text }], reasoning: '' });
      continue;
    }

    if (type === 'assistant/message') {
      const blocks = readBlocks(data.message?.content);
      const target = ensureAssistant();
      if (blocks.text) target.parts.push({ type: 'text', text: blocks.text });
      if (blocks.reasoning) target.reasoning += blocks.reasoning;
      for (const tool of blocks.tools) {
        // 必须索引「推进 parts 的那个对象本身」：若 push 副本、索引原对象，
        // 后面 tool/result 回填就会改到一份没人渲染的副本上（曾踩过）。
        const part = { type: 'tool', ...tool };
        target.parts.push(part);
        if (tool.callId) toolIndex.set(tool.callId, part);
      }
      continue;
    }

    if (type === 'tool/result') {
      const callId = String(data.message?.source?.callId || data.callId || '');
      const tool = toolIndex.get(callId);
      if (tool) {
        tool.status = data.message?.isError ? 'error' : 'done';
        tool.result = summarizeToolResult(data.message?.content);
      }
      continue;
    }

    if (type === 'turn/end') {
      // 一轮结束：把还挂在 running 的工具标成结束，避免 UI 一直转圈。
      for (const tool of toolIndex.values()) {
        if (tool.status === 'running') tool.status = 'done';
      }
      current = null;
    }
  }
  return messages;
}

/** 工具结果压成短文本（结果可能是块数组或纯文本）。 */
function summarizeToolResult(content) {
  if (content === undefined || content === null) return '';
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (typeof b === 'string' ? b : (b?.type === 'text' ? b.text : '')))
      .filter(Boolean)
      .join('\n');
  } else text = String(content);
  return text.length > TOOL_RESULT_MAX ? `${text.slice(0, TOOL_RESULT_MAX)}\n…（已截断）` : text;
}

module.exports = {
  request,
  streamSession,
  foldEvents,
  readBlocks,
  formatArgs,
  summarizeToolResult,
  newMessage,
  HISTORY_PAGE,
};