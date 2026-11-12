/**
 * DSH 编辑器模式 —— Client 半边（S0 PoC）。
 *
 * 注册三处：
 *  - conversation.session.header.utilities：右上角「Agents / 编辑器」分段切换控件；
 *  - sidebar.panellist：一级入口图标；
 *  - main (key: 'editor')：全屏 VS Code 编辑器面板（iframe 直连回环 code-server）。
 *
 * 模式切换经 ctx.layout.selectPanel('editor') / selectPanel(null) 完成；
 * 后者回到内置 Agents 对话。样式只用 --dsw-alias-* 主题 token，
 * 不 import 任何 Harness Client 包，不写 DOM 到组件之外。
 *
 * S0 说明：iframe 直连 http://127.0.0.1:<port>（而非 /editor/ 同源反代）。
 * 原因：code-server 的 WebSocket 走多条动态路径，DSH 的 registerUpgrade 只支持
 * exact path，S0 阶段无法覆盖；直连让 code-server 自己处理 WS，最稳。
 * 同源反代留到 S3（需要枚举/代理全部 upgrade 路径）。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-editor-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useSyncExternalStore } = React;

    const NS = '@local/dsh-editor-mode';
    const PANEL_ID = 'editor';
    /** 加载超时阈值：超过这个时间还没收到 onLoad，就认为 iframe 是白的并展示可操作提示。 */
    const STALL_MS = 12000;

    // 兜底地址：Host 未就绪时仍能用（端口与 config.upstreamPort 一致）。
    // 面板挂载后会从 /editor-status 读取真实 upstream 并替换，避免硬编码漂移。
    const FALLBACK_EDITOR_URL = 'http://127.0.0.1:3999/';

    // ---- 样式：组件内注入，卸载即移除；仅使用主题 token ----
    const CSS = `
      .dem-switch{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;
        background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.10));
        border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.22));}
      .dem-switch button{appearance:none;border:0;background:transparent;cursor:pointer;
        font:inherit;font-size:12px;line-height:1;padding:6px 10px;border-radius:6px;
        color:var(--dsw-alias-fg-secondary,#888);white-space:nowrap;transition:background .12s,color .12s;}
      .dem-switch button:hover{color:var(--dsw-alias-fg-primary,#111);}
      .dem-switch button[data-active="true"]{
        background:var(--dsw-alias-bg-surface,#fff);color:var(--dsw-alias-fg-primary,#111);
        box-shadow:0 1px 2px var(--dsw-alias-shadow-sm,rgba(0,0,0,.12));}
      .dem-switch button:focus-visible{outline:2px solid var(--dsw-alias-border-focus,#247bbf);outline-offset:1px;}
      .dem-glyph{width:18px;height:18px;display:block;}
      /* main 的 keyed slot 可能包了一层无固定高度的 wrapper；
         absolute inset:0 不依赖父链上的 100% 高度，保证撑满中央列。 */
      .dem-panel{position:absolute;inset:0;display:flex;flex-direction:column;
        background:var(--dsw-alias-bg-canvas,#fff);overflow:hidden;}
      .dem-bar{display:flex;align-items:center;gap:10px;flex:0 0 auto;height:38px;padding:0 12px;
        border-bottom:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.18));
        background:var(--dsw-alias-bg-surface,#fff);}
      .dem-title{font-size:12px;font-weight:600;color:var(--dsw-alias-fg-primary,#111);}
      .dem-sub{font-size:11px;color:var(--dsw-alias-fg-tertiary,#999);overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;max-width:52vw;}
      .dem-spacer{flex:1;}
      .dem-btn{appearance:none;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.28));
        background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.08));cursor:pointer;font:inherit;
        font-size:11px;padding:4px 10px;border-radius:6px;color:var(--dsw-alias-fg-secondary,#666);}
      .dem-btn:hover{color:var(--dsw-alias-fg-primary,#111);}
      .dem-frame{flex:1;border:0;width:100%;height:100%;background:var(--dsw-alias-bg-canvas,#fff);}
      .dem-state{position:absolute;inset:38px 0 0;display:flex;align-items:center;justify-content:center;
        flex-direction:column;gap:8px;font-size:13px;color:var(--dsw-alias-fg-secondary,#888);
        background:var(--dsw-alias-bg-canvas,#fff);}
      .dem-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-fg-tertiary,#bbb);}
      .dem-hint{font-size:11px;opacity:.65;max-width:60ch;text-align:center;line-height:1.6;}
      .dem-state-title{font-size:13px;font-weight:600;color:var(--dsw-alias-fg-primary,#111);}
    `;

    function Style() {
      return h('style', { 'data-dem': NS }, CSS);
    }

    // ---- 右上角分段切换控件 ----
    // 稳定的空快照/无操作订阅：避免每次渲染生成新函数引用，
    // 否则 useSyncExternalStore 会反复重订阅甚至触发无限循环。
    const EMPTY_SNAPSHOT = { activePanelId: null };
    const NOOP_UNSUBSCRIBE = () => () => {};
    const getEmptySnapshot = () => EMPTY_SNAPSHOT;

    function ModeSwitch({ layout }) {
      // panelInfo 是 { getSnapshot, subscribe } 的 ObservableSnapshot。
      const info = layout?.panelInfo;
      const subscribe = useCallback(
        (listener) => (info?.subscribe ? info.subscribe(listener) : NOOP_UNSUBSCRIBE()),
        [info],
      );
      const getSnapshot = useCallback(
        () => (info?.getSnapshot ? info.getSnapshot() : EMPTY_SNAPSHOT),
        [info],
      );
      const snapshot = useSyncExternalStore(subscribe, getSnapshot, getEmptySnapshot);
      const active = snapshot?.activePanelId === PANEL_ID;
      const go = useCallback((editor) => {
        try { layout.selectPanel(editor ? PANEL_ID : null); }
        catch (e) { /* 面板未注册时保持对话，不抛到渲染层 */ }
      }, [layout]);
      return h(React.Fragment, null,
        h(Style, null),
        h('div', { className: 'dem-switch', role: 'group', 'aria-label': '工作模式' },
          h('button', {
            type: 'button', 'data-active': String(!active),
            'aria-pressed': String(!active), onClick: () => go(false),
          }, 'Agents'),
          h('button', {
            type: 'button', 'data-active': String(active),
            'aria-pressed': String(active), onClick: () => go(true),
          }, '编辑器')));
    }

    // ---- 侧栏一级入口图标 ----
    function EditorGlyph({ size, active }) {
      return h('svg', {
        className: 'dem-glyph', viewBox: '0 0 24 24', width: size || 18, height: size || 18,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        style: { opacity: active ? 1 : 0.75 },
      },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
        h('path', { d: 'M3 9h18' }),
        h('path', { d: 'M8 13l-2 2 2 2M16 13l2 2-2 2' }));
    }

    // ---- 编辑器 → Agents 选区桥 ----
    // 隐藏的 dock 占位：它注册在 session 作用域的 conversation.input.dock 槽，
    // 因此 inject(sessionId) 能拿到该 Session 的 conversation.input facade，
    // 进而把 VS Code 选区写进 Agents 输入框。渲染为 null，不占任何空间。
    const BRIDGE_EVENT = 'dsh-editor:selection';

    function BridgeDock({ getInput }) {
      useEffect(() => {
        const onSelection = (event) => {
          const detail = event.detail;
          if (!detail?.text) return;
          const input = getInput?.();
          if (!input) return;
          try {
            // 追加到现有草稿，而不是覆盖用户已输入的内容。
            const current = input.state?.getSnapshot?.()?.draft ?? '';
            const next = current ? `${current}\n${detail.text}` : detail.text;
            input.setDraft(next);
          } catch { /* phase 非 plain 时忽略，不打断用户 */ }
        };
        window.addEventListener(BRIDGE_EVENT, onSelection);
        return () => window.removeEventListener(BRIDGE_EVENT, onSelection);
      }, [getInput]);
      return null;
    }

    // ---- 全屏编辑器面板 ----
    // iframe 无条件挂载：status fetch 只用于取真实 upstream 地址与默认项目路径，
    // 绝不门控渲染（跨域 / 鉴权 / 时序任一失败都不该留下一整块白屏）。
    // 打开其它项目目录用 code-server 的 ?folder= 参数，无需重启上游进程。
    function EditorPanel({ layout, uiWorkspace }) {
      const [nonce, setNonce] = useState(0);
      const [loaded, setLoaded] = useState(false);
      const [stalled, setStalled] = useState(false);
      const [info, setInfo] = useState(null);   // { upstream, workspace, folder, status } | null
      // Host 半边是否可达。false 表示 /editor-status 404 —— 即 Host 插件没被加载，
      // 这时 iframe 一定是白屏，必须把它说清楚，而不是让用户对着白板猜。
      const [hostOk, setHostOk] = useState(true);
      const [folder, setFolder] = useState('');  // 当前打开的目录；空 = 用 Host 默认值

      useEffect(() => {
        let alive = true;
        const ctrl = new AbortController();
        let timer = null;
        const probe = async () => {
          try {
            const r = await fetch('/editor-status', { signal: ctrl.signal });
            if (!r.ok) {
              // 404 = Host 路由根本没注册（插件 Host 半边未加载）；
              // 401 = 已注册但当前页面没通过鉴权。两种都不该继续等白屏。
              if (alive && r.status === 404) setHostOk(false);
              return;
            }
            if (alive) setHostOk(true);
            const j = await r.json();
            if (alive && j?.upstream) {
              setInfo(j);
              // 只在用户还没手动选过目录时采用 Host 默认目录。
              setFolder((prev) => prev || j.folder || '');
            }
            // 后端在启动/重启/失败时继续探活：恢复后自动重建 iframe，
            // 用户不用手动点「重载」。
            if (alive && j?.status && j.status !== 'ready') {
              timer = setTimeout(probe, Math.max(1000, Number(j.nextRetryMs) || 1500));
            }
          } catch { /* 保留兜底地址，不影响 iframe */ }
        };
        void probe();
        return () => { alive = false; ctrl.abort(); if (timer) clearTimeout(timer); };
      }, [nonce]);

      const reload = useCallback(() => {
        setLoaded(false);
        setStalled(false);
        setNonce((n) => n + 1);
      }, []);

      // 看门狗：iframe 的 onLoad 在「页面加载了但是白屏」时也会触发，
      // 真正可靠的判断是「有没有拿到过 workbench」。这里只在长时间没加载完时
      // 给出一条可操作提示，不隐藏 iframe（避免误判把正常页面盖住）。
      useEffect(() => {
        setStalled(false);
        if (loaded) return undefined;
        const timer = setTimeout(() => setStalled(true), STALL_MS);
        return () => clearTimeout(timer);
      }, [loaded, nonce, info?.upstream]);

      // 「打开目录」：调用 DSH 的目录选择器，之后只改 iframe 的 ?folder= 参数。
      const openDirectory = useCallback(async () => {
        try {
          const picked = await uiWorkspace?.pickDirectory?.();
          if (picked) { setLoaded(false); setFolder(picked); setNonce((n) => n + 1); }
        } catch { /* 用户取消或选择器不可用，保持现状 */ }
      }, [uiWorkspace]);

      // 显式带 ?folder=：code-server 会打开该目录，
      // 也避免它自己 302 到 ./?folder=... 时丢掉工作区。
      // 重新加载靠 key={nonce} 强制卸载/重建 iframe。
      const base = (info?.upstream || FALLBACK_EDITOR_URL).replace(/\/?$/, '/');
      const src = folder ? `${base}?folder=${encodeURIComponent(folder)}` : base;
      const label = folder || info?.workspace || 'VS Code';

      return h('div', { className: 'dem-panel' },
        h(Style, null),
        h('div', { className: 'dem-bar' },
          h('span', { className: 'dem-title' }, '编辑器'),
          h('span', { className: 'dem-sub' }, label),
          h('span', { className: 'dem-spacer' }),
          h('button', {
            className: 'dem-btn', type: 'button', title: '打开其它项目目录',
            onClick: openDirectory,
          }, '打开目录'),
          h('button', {
            className: 'dem-btn', type: 'button', title: '重新加载编辑器', onClick: reload,
          }, '重载'),
          h('button', {
            className: 'dem-btn', type: 'button', title: '返回 Agents 对话',
            onClick: () => { try { layout.selectPanel(null); } catch {} },
          }, '返回 Agents')),
        // 不加 sandbox：VS Code 的下载、弹窗、扩展 webview、ServiceWorker 才能完整工作。
        // 跨 origin 由 code-server 的 --trusted-origins '*' + --auth none 放行。
        h('iframe', {
          key: `${nonce}:${src}`, className: 'dem-frame', src,
          title: 'VS Code 编辑器',
          allow: 'clipboard-read; clipboard-write; fullscreen',
          onLoad: () => setLoaded(true),
        }),
        // 后端异常时给出与状态匹配的说明，而不是让人对着白板猜。
        !hostOk ? h('div', { className: 'dem-state' },
          h('span', { className: 'dem-state-title' }, '编辑器后端未启动'),
          h('span', { className: 'dem-hint' },
            '/editor-status 返回 404 —— 宿主插件（editor-mode）的 Host 半边没有加载。'),
          h('span', { className: 'dem-hint' },
            '常见原因：DSH 刚升级/重启过、插件被禁用，或插件加载时抛错。'),
          h('button', {
            className: 'dem-btn', type: 'button',
            onClick: () => { setLoaded(false); setNonce((n) => n + 1); },
          }, '重试'))
          : (info?.status === 'failed' || info?.status === 'restarting'
            ? h('div', { className: 'dem-state' },
              h('span', { className: 'dem-state-title' },
                info.status === 'failed' ? '编辑器启动失败' : '编辑器正在重启'),
              info?.error ? h('span', { className: 'dem-hint' }, String(info.error)) : null,
              info?.status === 'restarting'
                ? h('span', { className: 'dem-hint' },
                  `第 ${info.restarts || 1} 次自动重启，稍候会自动连上…`)
                : null,
              info?.status === 'failed'
                ? h('span', { className: 'dem-hint' },
                  '若提示 code-server 未安装，按上面的命令装好后再点重试。')
                : null,
              h('button', { className: 'dem-btn', type: 'button', onClick: reload }, '重载'))
            : (!loaded ? h('div', { className: 'dem-state' },
              h('span', { className: 'dem-dot' }),
              h('span', null, stalled ? '编辑器仍未就绪' : '正在连接编辑器…'),
              h('span', { className: 'dem-hint' }, label),
              stalled ? h('span', { className: 'dem-hint' },
                '若长时间空白：点「重载」；仍不行说明 code-server 没起来（见 README 排查）。') : null,
              stalled ? h('button', { className: 'dem-btn', type: 'button', onClick: reload }, '重载') : null,
            ) : null)));
    }

    return {
      // sessions 必须声明：桥接需要按 sessionId 解析 scope。未 inject 时访问
      // ctx.sessions 会直接抛错，而错误发生在槽 entries 遍历中会让整个 main 面板崩。
      inject: ['slots', 'layout', 'sessions'],
      apply(ctx) {
        // 右上角分段控件
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: `${NS}#mode-switch`,
          order: 60,
          label: () => 'Agents / 编辑器',
          inject: () => ({ layout: ctx.layout }),
        }, ModeSwitch));

        // 侧栏一级入口图标（点击由宿主 ui-sidebar 调 layout.selectPanel(id)）
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => '编辑器',
        }, EditorGlyph));

        // 全屏编辑器面板
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({
            layout: ctx.layout,
            // 必须用 ctx.get：uiWorkspace 未声明依赖时直接访问 ctx.uiWorkspace 会抛错。
            uiWorkspace: ctx.get('uiWorkspace'),
          }),
        }, EditorPanel));

        // 选区注入桥：session 作用域，能拿到 conversation.input facade。
        // 整块防御式注册：桥接是可选增强，任何失败都不能影响编辑器主面板。
        try {
          const sessions = ctx.get('sessions');
          if (sessions?.scope) {
            ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
              name: 'conversation.input.dock',
              id: `${NS}#bridge`,
              order: 90,
              label: () => 'DSH 编辑器选区桥',
              inject: (sessionId) => {
                let input;
                try {
                  const actx = sessions.scope(sessionId);
                  const conversation = actx?.get?.('conversation');
                  input = conversation?.input?.for?.(actx);
                } catch { /* 该 session 尚未保留 scope 时静默降级 */ }
                return { getInput: () => input };
              },
            }, BridgeDock));
          }
        } catch { /* 桥接不可用时不影响编辑器 */ }

        // 轮询 Host 的待发送选区队列：扩展 POST → Host 缓存 → 这里取走。
        // 取到后切回 Agents 并派发事件，由 BridgeDock 注入输入框。
        const poll = async () => {
          try {
            const r = await fetch('/editor-bridge/pending', { cache: 'no-store' });
            if (!r.ok) return;
            const { items } = await r.json();
            if (!Array.isArray(items) || items.length === 0) return;
            try { ctx.layout?.selectPanel(null); } catch { /* 保持现状 */ }
            for (const item of items) {
              window.dispatchEvent(new CustomEvent(BRIDGE_EVENT, {
                detail: { file: item.file, line: item.line, text: item.text },
              }));
            }
          } catch { /* 暂时不可达时跳过，下一轮再试 */ }
        };
        const timer = setInterval(poll, 1500);
        ctx.effect(() => () => clearInterval(timer));
      },
    };
  },
});
