/**
 * 历史面板前端（webview）。
 *
 * 职责只有渲染与转发：
 *  - 渲染由扩展主机算好的分组结果（今天/昨天/近 7 天/更早）
 *  - 搜索防抖后交给主机，主机调 DSH 的跨会话搜索
 *  - 点击一行 → 交给主机切换会话
 *
 * 这里不做任何数据加工，避免「面板看到的」和「聊天里打开的」不一致。
 */
(function () {
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  const error = document.getElementById('error');
  const refresh = document.getElementById('refresh');

  let timer = null;
  q.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      vscode.postMessage({ type: 'search', q: q.value.trim() });
    }, 250);
  });
  refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

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

  /** 目录取最后两段，避免长路径把标题挤没。 */
  function shortDir(cwd) {
    if (!cwd) return '';
    const parts = String(cwd).split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join('/');
  }

  function render(state) {
    const items = state.items || [];
    const groups = state.grouped || [];
    error.hidden = !state.error;
    if (state.error) error.textContent = state.error;
    empty.hidden = items.length > 0 || Boolean(state.error);
    empty.textContent = state.query ? `没有匹配「${state.query}」的会话` : '还没有历史会话';

    list.textContent = '';
    for (const group of groups) {
      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = group.label;
      list.appendChild(title);
      for (const item of group.items) {
        const row = document.createElement('div');
        row.className = 'row';
        row.title = item.cwd || '';

        const name = document.createElement('div');
        name.className = 'title';
        name.textContent = item.title || shortDir(item.cwd) || item.id.slice(0, 12);
        row.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const bits = [timeLabel(item.updatedAt)];
        if (item.cwd) bits.push(shortDir(item.cwd));
        meta.textContent = bits.filter(Boolean).join(' · ');
        row.appendChild(meta);

        if (item.snippet) {
          const snip = document.createElement('div');
          snip.className = 'snippet';
          snip.textContent = item.snippet.replace(/\s+/g, ' ').slice(0, 100);
          row.appendChild(snip);
        }

        row.addEventListener('click', () => {
          vscode.postMessage({ type: 'open', sessionId: item.id });
        });
        list.appendChild(row);
      }
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'state') render(msg);
  });

  vscode.postMessage({ type: 'ready' });
}());
