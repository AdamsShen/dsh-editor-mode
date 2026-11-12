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
 *             / listSessions / openFile
 *   来自扩展：state（全量）/ append / reasoning / sessions / prefill / contextInfo
 *
 * 消息模型（由扩展侧折叠，前端只渲染）：
 *   { role:'user'|'assistant',
 *     reasoning: string,
 *     parts: [ {type:'text', text} | {type:'tool', callId, name, summary, result, status} ] }
 */

(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  const inputEl = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const errEl = $('error');
  const sessionEl = $('session');
  const renameBtn = $('rename');
  const newBtn = $('new');
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
    sessions: [],
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

  /** 会话切换器：当前会话 + 最近会话列表。 */
  function renderSessions() {
    sessionEl.textContent = '';
    const current = document.createElement('option');
    current.value = state.sessionId || '';
    current.textContent = state.sessionTitle
      || (state.sessionId ? state.sessionId.slice(0, 12) : '新会话');
    sessionEl.appendChild(current);

    const others = state.sessions.filter((s) => s.id !== state.sessionId);
    if (others.length) {
      const group = document.createElement('optgroup');
      group.label = '最近会话';
      for (const item of others) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.title || shortDir(item.cwd) || item.id.slice(0, 12);
        group.appendChild(opt);
      }
      sessionEl.appendChild(group);
    }
  }

  function shortDir(cwd) {
    if (!cwd) return '';
    return String(cwd).split(/[\\/]/).filter(Boolean).slice(-2).join('/');
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
  renameBtn.addEventListener('click', () => {
    const title = window.prompt('会话标题', state.sessionTitle || '');
    if (title && title.trim()) vscode.postMessage({ type: 'renameSession', title: title.trim() });
  });
  sessionEl.addEventListener('change', () => {
    const id = sessionEl.value;
    if (id && id !== state.sessionId) vscode.postMessage({ type: 'selectSession', sessionId: id });
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
        renderSessions();
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
        state.sessions = Array.isArray(msg.items) ? msg.items : [];
        renderSessions();
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
  renderSessions();
  fullRender();
  vscode.postMessage({ type: 'ready' });
}());