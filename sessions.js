/**
 * 编辑器侧栏 Chat 的会话桥（Host 半边）。
 *
 * 定位：编辑器里的 Chat **不再是独立的纯模型对话**，而是 DSH 真实 Agent 会话的
 * 第二个视图。所有能力（工具调用、文件改动、权限）都来自 DSH 本身，
 * 这里只做「HTTP/SSE ↔ sessionController」的搬运与形状收敛。
 *
 * 为什么复用 sessionController 而不是自己调 ctx.llm：
 *  - 用 llm 就只能有纯文本，没有工具、没有会话历史、没有审批
 *  - 复用后编辑器里问过的问题，切到 Agents 模式能看到同一条会话（双模式 X）
 *
 * 依赖的 DSH 服务（均为 dsh-web-app / dsh-base 组成的一部分）：
 *  - `sessionController`：list / search / create / prompt / cancel / rename / follow / page
 *
 * 端点（全部回环 + token，与既有的 /editor-bridge/* 同一套鉴权）：
 *   GET  /editor-sessions/list                  → { items: [...] }  全部工作区
 *   GET  /editor-sessions/search?q=             → { items: [...] }
 *   POST /editor-sessions/create                → { sessionId, agentPreset? }
 *   POST /editor-sessions/prompt                → { accepted: true }
 *   POST /editor-sessions/cancel                → { ok: true }
 *   POST /editor-sessions/rename                → { ok: true }
 *   GET  /editor-sessions/history?sessionId=&beforeSeq=  → 历史页（冷会话也能读）
 *   GET  /editor-sessions/stream?sessionId=     → SSE：snapshot / event / delta / state
 *
 * 降级：sessionController 不可用时，所有端点返回 503 并说明原因，
 * 由扩展侧提示「DSH 未提供会话服务」，绝不静默失败。
 */

/** 会话桥的端点前缀。 */
export const SESSIONS_PREFIX = '/editor-sessions';

/**
 * 把 DSH 的历史记录解包成事件数组。
 *
 * DSH 的 history 返回 `{cursor, records, hasMore}`，records 每项是
 * `{type:'event', event:{type,seq,data}}`。直接读 `events` 会永远拿到空数组
 * （踩过：历史面板点开旧会话一片空白）。
 * @param {any} payload 可能是 {records} 或已经是事件数组
 * @returns {any[]} 事件数组
 */
function toEvents(payload) {
  if (Array.isArray(payload)) return payload;
  const records = Array.isArray(payload?.records) ? payload.records : [];
  return records.map((record) => record?.event ?? record).filter(Boolean);
}

/**
 * 需要推给 UI 的会话事件类型。
 * 其余（system/message、agent/inbox/* 等）是给模型看的，前端不需要。
 */
const UI_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/title',
  'approval/asked',
  'approval/decided',
]);

/** 单次请求体上限（prompt 可能带选区代码）。 */
const BODY_MAX = 512 * 1024;

/**
 * 把 DSH 的 list 项收敛成编辑器需要的形状。
 * 只暴露 UI 真正要用的字段，避免把内部 projection 全量漏给前端。
 * @param {object} item sessionController.list() 的一项
 * @returns {{id,title,cwd,updatedAt,running,blank,parentSessionId}}
 */
function toSessionItem(item) {
  const title = item?.projections?.values?.title;
  return {
    id: String(item?.sessionId ?? ''),
    // 标题来自 sessionTitle 投影；没生成过时前端用 cwd 兜底显示。
    title: typeof title === 'string' && title ? title : '',
    cwd: typeof item?.cwd === 'string' ? item.cwd : '',
    updatedAt: Number(item?.updatedAt) || 0,
    running: Boolean(item?.running),
    blank: Boolean(item?.blank),
    parentSessionId: typeof item?.parentSessionId === 'string' ? item.parentSessionId : '',
  };
}

/**
 * 注册会话桥路由。
 * @param {object} opts
 * @param {object} opts.ctx 插件上下文（取 DSH 服务）
 * @param {object} opts.webServer dsh-host-webserver 服务
 * @param {string} opts.token 回环 token
 * @param {object} opts.deps 从 index.js 传入的小工具（避免循环 import）
 * @param {(req)=>boolean} opts.deps.loopbackOnly
 * @param {(req,url)=>string} opts.deps.tokenFromRequest
 * @param {(req,limit)=>Promise<object>} opts.deps.readJsonBody
 * @param {(res)=>object} opts.deps.sseWriter
 * @returns {()=>void} 统一 disposer
 */
export function registerSessionRoutes({ ctx, webServer, token, deps }) {
  const { loopbackOnly, tokenFromRequest, readJsonBody, sseWriter } = deps;
  const disposers = [];

  /** 取会话服务；不可用时统一 503，不让调用方自己去判空。 */
  const controller = () => ctx.get('sessionController');

  /** 统一的 JSON 响应。 */
  const json = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  };

  /** 统一的前置校验：回环 + token + 方法。返回 true 表示已拒绝。 */
  const guard = (req, res, method = 'GET') => {
    if (!loopbackOnly(req)) { res.writeHead(403); res.end(); return true; }
    if (method && req.method !== method) {
      res.writeHead(405, { Allow: method });
      res.end();
      return true;
    }
    return false;
  };

  /** 取 body 里的 token（POST 走 body，GET 走 header/query）。 */
  const bodyTokenOk = (body) => body?.token === token;

  // ---- 列表：全部工作区 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/list`,
    handler: async (req, res) => {
      if (guard(req, res, 'GET')) return;
      const url = new URL(req.url, 'http://localhost');
      if (tokenFromRequest(req, url) !== token) { json(res, 401, { error: 'unauthorized' }); return; }

      const sc = controller();
      if (!sc?.list) { json(res, 503, { error: 'DSH 未提供会话服务（sessionController）' }); return; }

      try {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const result = await sc.list({}, ac.signal);
        const items = Array.isArray(result?.items) ? result.items.map(toSessionItem) : [];
        json(res, 200, { items });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
    },
  }));

  // ---- 搜索：跨会话 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/search`,
    handler: async (req, res) => {
      if (guard(req, res, 'GET')) return;
      const url = new URL(req.url, 'http://localhost');
      if (tokenFromRequest(req, url) !== token) { json(res, 401, { error: 'unauthorized' }); return; }
      const query = (url.searchParams.get('q') || '').trim();
      if (!query) { json(res, 200, { items: [] }); return; }

      const sc = controller();
      if (!sc?.search) { json(res, 503, { error: 'DSH 未提供会话搜索' }); return; }

      try {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const result = await sc.search({ query }, ac.signal);
        // search 的 items 是命中片段，形状与 list 不同，这里只挑前端要用的。
        const items = (Array.isArray(result?.items) ? result.items : []).map((hit) => ({
          id: String(hit?.sessionId ?? ''),
          cwd: typeof hit?.cwd === 'string' ? hit.cwd : '',
          updatedAt: Number(hit?.updatedAt) || 0,
          title: typeof hit?.title === 'string' ? hit.title : '',
          snippet: typeof hit?.snippet === 'string' ? hit.snippet : '',
        }));
        json(res, 200, { items, nextCursor: result?.nextCursor ?? null });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
    },
  }));

  // ---- 新建会话 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/create`,
    handler: async (req, res) => {
      if (guard(req, res, 'POST')) return;
      const parsed = await readJsonBody(req, BODY_MAX);
      if (parsed.tooLarge) { json(res, 413, { error: 'body too large' }); return; }
      if (parsed.invalid) { json(res, 400, { error: 'invalid json' }); return; }
      if (!bodyTokenOk(parsed.value)) { json(res, 401, { error: 'unauthorized' }); return; }

      const sc = controller();
      if (!sc?.create) { json(res, 503, { error: 'DSH 未提供会话创建' }); return; }

      const input = parsed.value || {};
      try {
        const created = await sc.create({
          ...(typeof input.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}),
          ...(typeof input.agentPreset === 'string' && input.agentPreset
            ? { agentPreset: input.agentPreset } : {}),
          // reusable：复用当前空白会话，避免连点「新对话」堆一堆空会话
          reusable: true,
        });
        json(res, 200, {
          sessionId: String(created?.sessionId ?? ''),
          agentPreset: created?.agentPreset ?? null,
        });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
    },
  }));

  // ---- 发送消息（触发 Agent 真正干活）----
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/prompt`,
    handler: async (req, res) => {
      if (guard(req, res, 'POST')) return;
      const parsed = await readJsonBody(req, BODY_MAX);
      if (parsed.tooLarge) { json(res, 413, { error: 'body too large' }); return; }
      if (parsed.invalid) { json(res, 400, { error: 'invalid json' }); return; }
      const input = parsed.value || {};
      if (!bodyTokenOk(input)) { json(res, 401, { error: 'unauthorized' }); return; }

      const sessionId = String(input.sessionId || '');
      const text = String(input.text || '').trim();
      if (!sessionId || !text) { json(res, 400, { error: 'sessionId 与 text 必填' }); return; }

      const sc = controller();
      if (!sc?.prompt) { json(res, 503, { error: 'DSH 未提供会话发送' }); return; }

      try {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        await sc.prompt({
          sessionId,
          requestId: String(input.requestId || `ed-${Date.now().toString(36)}`),
          content: [{ type: 'text', text }],
        }, ac.signal);
        json(res, 200, { accepted: true });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
    },
  }));

  // ---- 取消 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/cancel`,
    handler: async (req, res) => {
      if (guard(req, res, 'POST')) return;
      const parsed = await readJsonBody(req, BODY_MAX);
      if (parsed.invalid) { json(res, 400, { error: 'invalid json' }); return; }
      const input = parsed.value || {};
      if (!bodyTokenOk(input)) { json(res, 401, { error: 'unauthorized' }); return; }

      const sc = controller();
      if (!sc?.cancel) { json(res, 503, { error: 'DSH 未提供会话取消' }); return; }
      try {
        await sc.cancel({ sessionId: String(input.sessionId || '') });
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
    },
  }));

  // ---- 重命名 ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/rename`,
    handler: async (req, res) => {
      if (guard(req, res, 'POST')) return;
      const parsed = await readJsonBody(req, BODY_MAX);
      if (parsed.invalid) { json(res, 400, { error: 'invalid json' }); return; }
      const input = parsed.value || {};
      if (!bodyTokenOk(input)) { json(res, 401, { error: 'unauthorized' }); return; }

      const sc = controller();
      if (!sc?.rename) { json(res, 503, { error: 'DSH 未提供会话重命名' }); return; }
      try {
        await sc.rename({
          sessionId: String(input.sessionId || ''),
          title: String(input.title || '').slice(0, 200),
        });
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
    },
  }));

  // ---- 历史页（含冷会话）----
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/history`,
    handler: async (req, res) => {
      if (guard(req, res, 'GET')) return;
      const url = new URL(req.url, 'http://localhost');
      if (tokenFromRequest(req, url) !== token) { json(res, 401, { error: 'unauthorized' }); return; }
      const sessionId = String(url.searchParams.get('sessionId') || '');
      if (!sessionId) { json(res, 400, { error: 'sessionId 必填' }); return; }

      const sc = controller();
      if (!sc?.page) { json(res, 503, { error: 'DSH 未提供会话历史' }); return; }

      // 注意：不能直接 Number(get(...)) —— 缺省时 get 返回 null，Number(null)
      // 得到 0，会被当成「从第 0 条取页」从而拿到空页（这是历史面板空白的真凶）。
      const rawBefore = url.searchParams.get('beforeSeq');
      const beforeSeq = rawBefore === null || rawBefore === '' ? NaN : Number(rawBefore);
      try {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const result = await sc.page({
          address: { kind: 'session', sessionId },
          // 必须显式给 beforeSeq：实测（2026-11，DSH 0.2.2-rc.1）不传时
          // DSH 的 paginate 会算出空页（cursor 正常但 records 为空），
          // 表现就是「历史面板点开旧会话一片空白」。给一个足够大的值
          // 即取日志尾部，效果等同「最近 N 条」。
          beforeSeq: Number.isSafeInteger(beforeSeq) && beforeSeq >= 0
            ? beforeSeq
            : Number.MAX_SAFE_INTEGER,
          maxMessages: 50,
        }, ac.signal);
        json(res, 200, {
          cursor: result?.cursor ?? null,
          hasMore: Boolean(result?.hasMore),
          events: toEvents(result),
        });
      } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
      }
    },
  }));

  // ---- 实时流：会话事件 + 助手文字增量 ----
  //
  // 这是整个桥最关键的一条：编辑器侧栏能不能「看到 Agent 在干什么」全靠它。
  // DSH 的 follow() 产出三类帧（已核实）：
  //   { type:'snapshot', header, projections, ...history }   开篇快照
  //   { type:'event', event }                                持久事件（tool/call、turn/start…）
  //   { type:'assistant-stream', frame:{type:'start'|'chunk', chunk} }  助手文字增量
  // 这里逐条转成 SSE，前端按 event 名分流。
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${SESSIONS_PREFIX}/stream`,
    handler: async (req, res) => {
      if (guard(req, res, 'GET')) return;
      const url = new URL(req.url, 'http://localhost');
      if (tokenFromRequest(req, url) !== token) { res.writeHead(401); res.end(); return; }
      const sessionId = String(url.searchParams.get('sessionId') || '');
      if (!sessionId) { res.writeHead(400); res.end('sessionId 必填'); return; }

      const sc = controller();
      if (!sc?.follow) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('DSH 未提供会话跟随（follow）');
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const sse = sseWriter(res);
      const ac = new AbortController();
      req.on('close', () => ac.abort());

      try {
        // assistantStream: true 才会带回文字增量帧；不传就只有持久事件，
        // 侧栏会「一直在转圈但不出字」（踩过）。
        for await (const frame of sc.follow({
          address: { kind: 'session', sessionId },
          activate: true,
          assistantStream: true,
        }, ac.signal)) {
          if (sse.closed) break;
          const type = frame?.type;
          if (type === 'snapshot') {
            sse.write('snapshot', {
              header: frame.header ?? null,
              // 快照里的首屏历史同样在 records 里，不解包会丢掉。
              events: toEvents(frame),
              hasMore: Boolean(frame.hasMore),
              cursor: frame.cursor ?? null,
            });
          } else if (type === 'event') {
            const event = frame.event ?? frame;
            const name = event?.type ?? '';
            // 白名单：system/message 里有整段系统提示（约 19KB），推给 webview
            // 既没用又会把每次会话的流量放大一个量级，这里直接挡掉。
            if (UI_EVENT_TYPES.has(name)) {
              sse.write('session-event', {
                type: name,
                seq: event?.seq ?? null,
                data: event?.data ?? null,
              });
            }
          } else if (type === 'assistant-stream') {
            const f = frame.frame ?? {};
            if (f.type === 'chunk') sse.write('assistant-chunk', f.chunk ?? null);
            else if (f.type === 'start') sse.write('assistant-start', { startedAfterSeq: f.startedAfterSeq ?? null });
            else sse.write('assistant-frame', { type: f.type ?? '' });
          } else {
            // 未知帧类型不丢：显式透传，便于版本漂移时排查
            sse.write('unknown-frame', { type: String(type ?? '') });
          }
        }
      } catch (err) {
        sse.write('error', { message: String(err?.message || err) });
      } finally {
        if (!res.writableEnded) res.end();
      }
    },
  }));

  // 显式返回 disposer：webServer.register 已随 ctx.effect 生命周期释放，
  // 这里只是让调用方有统一入口。
  return () => { for (const dispose of disposers) { try { dispose(); } catch { /* 已释放 */ } } };
}