/*
 * DSH Chat 侧栏前端（webview）。
 *
 * 职责边界：这里只做「显示 + 收集输入」，所有模型调用、持久化、上下文收集
 * 都在扩展的 Node 侧（extension.js）。webview 与扩展之间只传消息，
 * 不直接访问网络（CSP 也不允许），因此不会有第二次鉴权问题。
 *
 * 消息协议：
 *   发往扩展：ready / send / stop / selectModel / toggleContext / newChat
 *             / escalate{index} / refreshModels / openFile{path,line}
 *   来自扩展：state（全量）/ delta / reasoning / contextInfo / prefill
 */

(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const logEl = $('log');
  const inputEl = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const errEl = $('error');
  const modelEl = $('model');
  const ctxBtn = $('ctx');
  const ctxInfoEl = $('ctxinfo');
  const hintEl = $('hint');
  const emptyEl = $('empty');

  /** 与扩展同步的会话状态。 */
  const state = {
    messages: [],
    models: null,
    provider: '',
    model: '',
    busy: false,
    error: '',
    contextEnabled: true,
    contextLabel: '',
    hasEditor: false,
    effectiveModel: '',
  };

  /** 正在等待重绘的消息下标（用 rAF 合并高频 delta）。 */
  const dirty = new Set();
  let rafId = 0;

  // ---------------------------------------------------------------- 工具

  /** Markdown 渲染委托给 media/markdown.js（纯函数，可单独测试）。 */
  function renderMarkdown(source) {
    return window.DshMarkdown.render(source);
  }

  /** 草稿区随内容长高，最多到 CSS 的 max-height。 */
  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  function nearBottom() {
    return logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 48;
  }

  function scrollToBottom() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------------------------------------------------------------- 渲染

  function messageNode(message, index) {
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.role = message.role;
    el.dataset.index = String(index);
    if (message.pending) el.dataset.pending = 'true';

    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = message.role === 'user' ? '你' : 'DSH';
    if (message.role === 'assistant' && message.pending) role.textContent = 'DSH · 生成中';
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

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = renderMarkdown(message.content);
    el.appendChild(body);

    // 用户点了「停止」：在消息尾部留一个明确的痕迹，避免半句话看起来像模型出错。
    if (message.finish === 'aborted') {
      const note = document.createElement('div');
      note.className = 'msg-note';
      note.textContent = '（已停止生成）';
      el.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (message.role === 'assistant') {
      const escalate = document.createElement('button');
      escalate.type = 'button';
      escalate.textContent = '→ Agents';
      escalate.title = '把这条回复交给 DSH Agents，让它真正改代码';
      escalate.dataset.act = 'escalate';
      escalate.dataset.index = String(index);
      actions.appendChild(escalate);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制';
    copy.dataset.act = 'copy';
    copy.dataset.index = String(index);
    actions.appendChild(copy);
    el.appendChild(actions);

    return el;
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

  /** 只重绘一条消息（流式追加时用，避免整列表重建导致抖动）。 */
  function renderOne(index) {
    const message = state.messages[index];
    if (!message) return;
    const old = logEl.querySelector(`.msg[data-index="${index}"]`);
    if (!old) { fullRender(); return; }
    const stick = nearBottom();
    const fresh = messageNode(message, index);
    old.replaceWith(fresh);
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

  function renderModels() {
    const current = `${state.provider}\u0001${state.model}`;
    modelEl.textContent = '';
    const models = state.models;
    const providers = (models && models.providers) || [];
    let hasOptions = false;

    for (const provider of providers) {
      const list = provider.models || [];
      if (!list.length) continue;
      const group = document.createElement('optgroup');
      group.label = provider.name || provider.id;
      for (const model of list) {
        const option = document.createElement('option');
        option.value = `${provider.id}\u0001${model.id}`;
        option.textContent = model.name || model.id;
        if (option.value === current) option.selected = true;
        group.appendChild(option);
        hasOptions = true;
      }
      modelEl.appendChild(group);
    }

    if (!hasOptions) {
      const option = document.createElement('option');
      option.textContent = state.provider ? `${state.provider}/${state.model}` : '模型列表未就绪';
      modelEl.appendChild(option);
      modelEl.disabled = true;
      return;
    }
    modelEl.disabled = false;
    // 当前选择不在列表里（比如模型被删了）：补一个禁用项，避免 select 空白。
    if (current && !modelEl.value) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = `${state.provider}/${state.model}（不可用）`;
      option.selected = true;
      modelEl.insertBefore(option, modelEl.firstChild);
    }
  }

  function syncControls() {
    sendBtn.disabled = state.busy;
    stopBtn.hidden = !state.busy;
    errEl.hidden = !state.error;
    errEl.textContent = state.error || '';
    ctxBtn.setAttribute('aria-pressed', String(state.contextEnabled));
    ctxInfoEl.textContent = state.contextEnabled
      ? (state.hasEditor ? state.contextLabel : '未打开文件')
      : '不带上下文';
    hintEl.textContent = state.busy
      ? '正在生成…'
      : (state.effectiveModel ? `模型：${state.effectiveModel}` : '');
    if (!state.messages.length) inputEl.placeholder = '问点什么…（Enter 发送，Shift+Enter 换行）';
  }

  // ---------------------------------------------------------------- 交互

  function submit() {
    const text = inputEl.value.trim();
    if (!text || state.busy) return;
    // 乐观置忙，避免连点两次发出两轮；扩展随后会用 state 覆盖。
    state.busy = true;
    syncControls();
    vscode.postMessage({ type: 'send', text });
    inputEl.value = '';
    autoGrow();
  }

  function sendStop() {
    vscode.postMessage({ type: 'stop' });
  }

  // 消息区事件委托：复制 / 交回 Agents。
  logEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (button.dataset.act === 'copy') {
      const message = state.messages[index];
      const text = message ? String(message.content || '') : '';
      if (text) navigator.clipboard.writeText(text);
      return;
    }
    if (button.dataset.act === 'escalate') {
      vscode.postMessage({ type: 'escalate', index });
    }
  });

  // 代码块复制按钮在 Markdown 生成后才有，同样用委托。
  logEl.addEventListener('click', (event) => {
    const button = event.target.closest('button.copy[data-code]');
    if (!button) return;
    const code = decodeURIComponent(button.dataset.code || '');
    if (!code) return;
    navigator.clipboard.writeText(code);
    const previous = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => { button.textContent = previous; }, 1200);
  });

  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', sendStop);
  $('new').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));

  ctxBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleContext', enabled: !state.contextEnabled });
  });

  modelEl.addEventListener('change', () => {
    const [provider, model] = String(modelEl.value || '').split('\u0001');
    if (!provider || !model) return;
    vscode.postMessage({ type: 'selectModel', provider, model });
  });

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  });

  // 点击消息里的 `path/to/file.ts:12` 打开文件（只在行号存在时）。
  logEl.addEventListener('click', (event) => {
    if (event.target.closest('a, button')) return;
    const selection = window.getSelection();
    const word = selection && String(selection).trim();
    if (!word || word.length > 200) return;
    const match = /^([\w./@-]+\.[\w]+):(\d+)$/.exec(word);
    if (!match) return;
    vscode.postMessage({ type: 'openFile', path: match[1], line: Number(match[2]) });
  });

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'state': {
        state.messages = message.messages || [];
        state.models = message.models || null;
        state.provider = message.provider || '';
        state.model = message.model || '';
        state.busy = Boolean(message.busy);
        state.error = message.error || '';
        state.contextEnabled = message.contextEnabled !== false;
        state.contextLabel = message.contextLabel || '';
        state.hasEditor = Boolean(message.hasEditor);
        state.effectiveModel = message.effectiveModel || state.effectiveModel;
        renderModels();
        fullRender();
        syncControls();
        break;
      }
      case 'delta': {
        const target = state.messages[message.index];
        if (!target) break;
        target.content = String(target.content || '') + String(message.text || '');
        scheduleRender(message.index);
        break;
      }
      case 'reasoning': {
        const target = state.messages[message.index];
        if (!target) break;
        target.reasoning = String(target.reasoning || '') + String(message.text || '');
        scheduleRender(message.index);
        break;
      }
      case 'contextInfo': {
        state.contextLabel = message.label || '';
        state.hasEditor = Boolean(message.hasEditor);
        syncControls();
        break;
      }
      case 'prefill': {
        inputEl.value = String(message.text || '');
        autoGrow();
        inputEl.focus();
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        break;
      }
      default:
        break;
    }
  });

  // 启动：先让扩展推一次全量状态。
  vscode.postMessage({ type: 'ready' });
  syncControls();
}());