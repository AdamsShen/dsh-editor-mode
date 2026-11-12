/*
 * DSH Chat 侧栏前端（webview）。
 *
 * 定位变更（2026-11）：这里显示的**不再是独立纯模型对话**，而是 DSH 真实
 * Agent 会话（双模式 X 的编辑器侧视图）。所以会出现工具调用卡片。
 *
 * 职责边界：只做「渲染 + 收集输入」，所有会话操作都在扩展的 Node 侧。
 * webview 不直接联网（CSP 也不允许），避免第二次鉴权。
 *
 * 消息协议：
 *   发往扩展：ready / send / stop / newChat / selectSession / renameSession
 *             / listSessions / searchSessions / openFile
 *   来自扩展：state（全量）/ append / reasoning / sessions / allSessions
 *             / prefill / contextInfo
 *
 * 消息模型（由扩展侧折叠，前端只渲染）：
 *   { role:'user'|'assistant',
 *     reasoning: string,
 *     parts: [ {type:'text', text} | {type:'tool', callId, name, summary, result, status} ] }
 *
 * 交互形态对齐 CodeBuddy：
 *   - 顶部是「向右追加的会话 tab 条」，只显示标题，不显示会话 id；
 *     用户本次打开的会话才进 tab 条，历史里的条目不自动铺开。
 *   - 右上角时钟按钮打开「历史对话」覆盖层（全部工作区、可搜索、带返回）。
 */

(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  const inputEl = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const errEl = $('error');
  const tabsEl = $('tabs');
  const newBtn = $('new');
  const historyBtn = $('history');
  const overlayEl = $('history-overlay');
  const historyBackBtn = $('history-back');
  const historyRefreshBtn = $('history-refresh');
  const historyQEl = $('history-q');
  const historyListEl = $('history-list');
  const historyEmptyEl = $('history-empty');
  const historyErrEl = $('history-error');
  const ctxInfoEl = $('ctxinfo');
  const hintEl = $('hint');
  const emptyEl = $('empty');

  const state = {
    sessionId: '',
    sessionTitle: '',
    messages: [],
    busy: false,
    error: '',
    contextLabel: '',
    hasEditor: false,
    /** 最近会话（用于给未命名 tab 兜底标题），不放进 tab 条。 */
    sessions: [],
    /**
     * 本次会话期间打开过的 tab，按打开顺序向右追加。
     * 每项 {id, title}；title 为空时用「新会话 N」占位，绝不显示 id。
     */
    tabs: [],
    /** 历史覆盖层里的全部工作区会话。 */
    allSessions: [],
    historyQuery: '',
    historyError: '',
  };

  const dirty = new Set();
  let rafId = 0;

  // ---------------------------------------------------------------- 工具

  function renderMarkdown(source) {
    return window.DshMarkdown.render(source);
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  function nearBottom() {
    return logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 48;
  }

  function scrollToBottom() { logEl.scrollTop = logEl.scrollHeight; }

  /** 取消息里的纯文字（用于复制）。 */
  function textOf(message) {
    return (message.parts || [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }

  // ---------------------------------------------------------------- 渲染

  /** 工具调用卡片：一行摘要，点开看参数与结果。 */
  function toolNode(part) {
    const details = document.createElement('details');
    details.className = 'tool';
    details.dataset.status = part.status || 'done';

    const summary = document.createElement('summary');
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = part.name || '工具';
    summary.appendChild(name);

    if (part.summary) {
      const arg = document.createElement('span');
      arg.className = 'tool-arg';
      arg.textContent = part.summary;
      summary.appendChild(arg);
    }

    const status = document.createElement('span');
    status.className = 'tool-status';
    status.textContent = part.status === 'running' ? '执行中…'
      : part.status === 'error' ? '失败' : '完成';
    summary.appendChild(status);
    details.appendChild(summary);

    if (part.result) {
      const pre = document.createElement('pre');
      pre.className = 'tool-result';
      pre.textContent = part.result;
      details.appendChild(pre);
    }
    return details;
  }

  function messageNode(message, index) {
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.role = message.role;
    el.dataset.index = String(index);

    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = message.role === 'user' ? '你' : 'DSH';
    el.appendChild(role);

    if (message.reasoning) {
      const details = document.createElement('details');
      details.className = 'reasoning';
      const summary = document.createElement('summary');
      summary.textContent = `思考过程（${String(message.reasoning).length} 字）`;
      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'reasoning-body';
      body.textContent = message.reasoning;
      details.appendChild(body);
      el.appendChild(details);
    }

    for (const part of message.parts || []) {
      if (part.type === 'tool') {
        el.appendChild(toolNode(part));
        continue;
      }
      if (part.type !== 'text' || !String(part.text || '').trim()) continue;
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.innerHTML = renderMarkdown(part.text);
      // 文本里出现的 file:line 做成可点击（点击交给扩展打开文件）
      decorateFileRefs(body);
      el.appendChild(body);
    }

    if (message.role === 'assistant' && textOf(message).trim()) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制';
      copy.dataset.act = 'copy';
      copy.dataset.index = String(index);
      actions.appendChild(copy);
      el.appendChild(actions);
    }
    return el;
  }

  /**
   * 把正文里形如 `path/to/file.ts:42` 的文本标成可点击。
   * 只处理纯文本节点，避免破坏已渲染的 Markdown 结构。
   */
  function decorateFileRefs(root) {
    const pattern = /([\w./-]+\.\w{1,8}):(\d+)/g;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    for (const node of targets) {
      const text = node.nodeValue || '';
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'file-ref';
        link.dataset.file = match[1];
        link.dataset.line = match[2];
        link.textContent = match[0];
        frag.appendChild(link);
        last = match.index + match[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  function fullRender() {
    const stick = nearBottom();
    logEl.textContent = '';
    if (!state.messages.length) {
      logEl.appendChild(emptyEl);
      return;
    }
    for (let i = 0; i < state.messages.length; i++) {
      logEl.appendChild(messageNode(state.messages[i], i));
    }
    if (stick) scrollToBottom();
  }

  function renderOne(index) {
    const message = state.messages[index];
    if (!message) return;
    const old = logEl.querySelector(`.msg[data-index="${index}"]`);
    if (!old) { fullRender(); return; }
    const stick = nearBottom();
    old.replaceWith(messageNode(message, index));
    if (stick) scrollToBottom();
  }

  function scheduleRender(index) {
    dirty.add(index);
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      const indexes = [...dirty];
      dirty.clear();
      if (indexes.length > 4) { fullRender(); return; }
      for (const index of indexes) renderOne(index);
    });
  }

  /** 目录取最后两段，仅用于历史列表的副标题。 */
  function shortDir(cwd) {
    if (!cwd) return '';
    return String(cwd).split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  }

  /**
   * 保证当前会话在 tab 条里；点历史里的旧会话或「新建」时向右追加一个 tab。
   * tab 只放本次打开的会话，不把全部历史都铺开（否则上百条会挤爆侧栏）。
   */
  function ensureTab(id, title) {
    if (!id) return;
    const index = state.tabs.findIndex((t) => t.id === id);
    if (index >= 0) {
      if (title && title !== state.tabs[index].title) {
        state.tabs[index].title = title;
      }
      return;
    }
    state.tabs.push({ id, title: title || '' });
  }

  /** tab 显示名：优先真实标题，其次「新会话 N」，**任何情况都不显示 id**。 */
  function tabLabel(tab, index) {
    return tab.title && tab.title.trim() ? tab.title.trim() : `新会话 ${index + 1}`;
  }

  /** 渲染向右追加的 tab 条。 */
  function renderTabs() {
    tabsEl.textContent = '';
    state.tabs.forEach((tab, index) => {
      const item = document.createElement('div');
      item.className = 'tab';
      item.dataset.active = String(tab.id === state.sessionId);
      item.title = tabLabel(tab, index);

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tabLabel(tab, index);
      item.appendChild(label);

      // 双击 tab 重命名（不额外占按钮位置，与常见 IDE 习惯一致）
      item.addEventListener('dblclick', () => {
        const name = window.prompt('会话标题', tab.title || '');
        if (name && name.trim()) {
          vscode.postMessage({ type: 'renameSession', title: name.trim() });
        }
      });

      item.addEventListener('click', () => {
        if (tab.id !== state.sessionId) {
          vscode.postMessage({ type: 'selectSession', sessionId: tab.id });
        }
      });
      tabsEl.appendChild(item);
    });
    // 让当前 tab 保持可见（tab 多时横向滚动）
    const active = tabsEl.querySelector('.tab[data-active="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------------------------------------------------------------- 历史覆盖层

  function showHistory(open) {
    overlayEl.hidden = !open;
    if (open) {
      historyQEl.value = state.historyQuery;
      historyQEl.focus();
      // 打开时拉全量；搜索时由 searchSessions 覆盖
      vscode.postMessage({ type: 'listSessions', all: true });
    }
  }

  /** 时间戳 → HH:MM（今天）或 M/D。 */
  function timeLabel(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${d.getMonth() + 1}/${d.getDate()}`;
  }

  /** 按「今天 / 昨天 / 近 7 天 / 更早」分组（前端自己算，扩展只给排序好的列表）。 */
  function groupByDay(items) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 24 * 3600 * 1000;
    const buckets = [
      { label: '今天', items: [] },
      { label: '昨天', items: [] },
      { label: '近 7 天', items: [] },
      { label: '更早', items: [] },
    ];
    for (const item of Array.isArray(items) ? items : []) {
      const t = Number(item?.updatedAt) || 0;
      if (t >= startOfToday) buckets[0].items.push(item);
      else if (t >= startOfToday - day) buckets[1].items.push(item);
      else if (t >= startOfToday - 7 * day) buckets[2].items.push(item);
      else buckets[3].items.push(item);
    }
    return buckets.filter((b) => b.items.length);
  }

  function renderAllSessions() {
    const items = state.allSessions || [];
    historyErrEl.hidden = !state.historyError;
    if (state.historyError) historyErrEl.textContent = state.historyError;
    historyEmptyEl.hidden = items.length > 0 || Boolean(state.historyError);
    historyEmptyEl.textContent = state.historyQuery
      ? `没有匹配「${state.historyQuery}」的对话`
      : '还没有历史对话';

    historyListEl.textContent = '';
    for (const group of groupByDay(items)) {
      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = group.label;
      historyListEl.appendChild(title);
      for (const item of group.items) {
        const row = document.createElement('div');
        row.className = 'history-row';
        row.title = item.cwd || '';

        const name = document.createElement('div');
        name.className = 'history-row-title';
        // 不显示 id：用标题，没标题用目录名
        name.textContent = item.title || shortDir(item.cwd) || '未命名对话';
        row.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'history-row-meta';
        const bits = [timeLabel(item.updatedAt)];
        if (item.cwd) bits.push(shortDir(item.cwd));
        meta.textContent = bits.filter(Boolean).join(' · ');
        row.appendChild(meta);

        if (item.snippet) {
          const snip = document.createElement('div');
          snip.className = 'history-row-snippet';
          snip.textContent = String(item.snippet).replace(/\s+/g, ' ').slice(0, 100);
          row.appendChild(snip);
        }

        row.addEventListener('click', () => {
          // 点历史项：作为新 tab 向右追加并打开，然后收起覆盖层
          vscode.postMessage({ type: 'openSession', sessionId: item.id, title: item.title || '' });
          showHistory(false);
        });
        historyListEl.appendChild(row);
      }
    }
  }

  function renderStatus() {
    errEl.hidden = !state.error;
    if (state.error) errEl.textContent = state.error;

    stopBtn.hidden = !state.busy;
    sendBtn.disabled = state.busy;
    sendBtn.textContent = state.busy ? '运行中…' : '发送';
    inputEl.placeholder = state.busy
      ? 'DSH 正在干活…可以先输入，等这轮结束再发'
      : '让 DSH 改点什么…（Enter 发送，Shift+Enter 换行）';

    ctxInfoEl.textContent = state.contextLabel || '';
    hintEl.textContent = state.sessionId ? '' : '首次发送会自动新建会话';
  }

  // ---------------------------------------------------------------- 事件

  function onSubmit() {
    const text = inputEl.value.trim();
    if (!text || state.busy) return;
    vscode.postMessage({ type: 'send', text });
    inputEl.value = '';
    autoGrow();
  }

  sendBtn.addEventListener('click', onSubmit);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  newBtn.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  historyBtn.addEventListener('click', () => showHistory(true));
  historyBackBtn.addEventListener('click', () => showHistory(false));
  historyRefreshBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'listSessions', all: true });
  });

  let searchTimer = null;
  historyQEl.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.historyQuery = historyQEl.value.trim();
      if (state.historyQuery) {
        vscode.postMessage({ type: 'searchSessions', q: state.historyQuery });
      } else {
        vscode.postMessage({ type: 'listSessions', all: true });
      }
    }, 250);
  });

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      onSubmit();
    }
  });

  logEl.addEventListener('click', (event) => {
    const link = event.target.closest?.('.file-ref');
    if (link) {
      event.preventDefault();
      vscode.postMessage({
        type: 'openFile',
        path: link.dataset.file,
        line: Number(link.dataset.line) || 1,
      });
      return;
    }
    const btn = event.target.closest?.('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'copy') {
      const message = state.messages[Number(btn.dataset.index)];
      if (message) void navigator.clipboard.writeText(textOf(message));
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'state':
        state.sessionId = msg.sessionId || '';
        state.sessionTitle = msg.sessionTitle || '';
        state.messages = Array.isArray(msg.messages) ? msg.messages : [];
        state.busy = Boolean(msg.busy);
        state.error = msg.error || '';
        state.contextLabel = msg.contextLabel || '';
        state.hasEditor = Boolean(msg.hasEditor);
        // 当前会话进入（或更新）tab 条；新建会话时 id 变化会自动向右追加
        if (state.sessionId) ensureTab(state.sessionId, state.sessionTitle);
        renderTabs();
        renderStatus();
        fullRender();
        break;
      case 'append': {
        // 增量就地追加到本地模型（与扩展侧的折叠规则一致），只重绘这一条，
        // 避免整列表重建导致滚动抖动。
        const idx = Number(msg.index);
        const target = state.messages[idx];
        if (target) {
          const last = target.parts[target.parts.length - 1];
          if (last && last.type === 'text') last.text += String(msg.text || '');
          else target.parts.push({ type: 'text', text: String(msg.text || '') });
        }
        scheduleRender(idx);
        renderStatus();
        break;
      }
      case 'reasoning': {
        const idx = Number(msg.index);
        const target = state.messages[idx];
        if (target) target.reasoning += String(msg.text || '');
        scheduleRender(idx);
        break;
      }
      case 'sessions':
        // 会话列表变更（标题生成后回推）：同步刷新 tab 上的标题
        state.sessions = Array.isArray(msg.items) ? msg.items : [];
        for (const tab of state.tabs) {
          const found = state.sessions.find((s) => s.id === tab.id);
          if (found?.title) tab.title = found.title;
        }
        renderTabs();
        break;
      case 'allSessions':
        // 历史覆盖层的数据（全部工作区 / 搜索结果）
        state.allSessions = Array.isArray(msg.items) ? msg.items : [];
        state.historyError = msg.error || '';
        renderAllSessions();
        break;
      case 'contextInfo':
        state.contextLabel = msg.label || '';
        state.hasEditor = Boolean(msg.hasEditor);
        renderStatus();
        break;
      case 'prefill':
        inputEl.value = String(msg.text || '');
        autoGrow();
        inputEl.focus();
        break;
      default:
        break;
    }
  });

  renderStatus();
  renderTabs();
  fullRender();
  vscode.postMessage({ type: 'ready' });
}());