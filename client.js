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

    // ---- 全屏编辑器面板 ----
    // iframe 无条件挂载：status fetch 只用于取真实 upstream 地址与项目路径，
    // 绝不门控渲染（跨域 / 鉴权 / 时序任一失败都不该留下一整块白屏）。
    function EditorPanel({ layout }) {
      const [nonce, setNonce] = useState(0);
      const [loaded, setLoaded] = useState(false);
      const [info, setInfo] = useState(null);   // { upstream, workspace, status } | null

      useEffect(() => {
        let alive = true;
        const ctrl = new AbortController();
        (async () => {
          try {
            const r = await fetch('/editor-status', { signal: ctrl.signal });
            if (!r.ok) return;
            const j = await r.json();
            if (alive && j?.upstream) setInfo(j);
          } catch { /* 保留兜底地址，不影响 iframe */ }
        })();
        return () => { alive = false; ctrl.abort(); };
      }, [nonce]);

      const reload = useCallback(() => { setLoaded(false); setNonce((n) => n + 1); }, []);
      // 显式带 ?folder=：code-server 会打开插件配置的项目目录，
      // 也避免它自己 302 到 ./?folder=... 时丢掉工作区。
      // 重新加载靠 key={nonce} 强制卸载/重建 iframe。
      const base = (info?.upstream || FALLBACK_EDITOR_URL).replace(/\/?$/, '/');
      const folder = info?.folder || '';
      const src = folder ? `${base}?folder=${encodeURIComponent(folder)}` : base;
      const label = info?.workspace || 'VS Code';

      return h('div', { className: 'dem-panel' },
        h(Style, null),
        h('div', { className: 'dem-bar' },
          h('span', { className: 'dem-title' }, '编辑器'),
          h('span', { className: 'dem-sub' }, label),
          h('span', { className: 'dem-spacer' }),
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
        !loaded ? h('div', { className: 'dem-state' },
          h('span', { className: 'dem-dot' }),
          h('span', null, '正在连接编辑器…'),
          h('span', { style: { fontSize: 11, opacity: .6 } }, label)) : null);
    }

    return {
      inject: ['slots', 'layout'],
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
          inject: () => ({ layout: ctx.layout }),
        }, EditorPanel));
      },
    };
  },
});
