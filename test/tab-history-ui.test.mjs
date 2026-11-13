/**
 * 测试：会话 tab 条 + 历史覆盖层（对齐 CodeBuddy 的交互）。
 *
 * 用极简假 DOM 跑真实的 chat.js，验证：
 *   - 顶部是向右追加的 tab，且**绝不显示会话 id**
 *   - 无标题时显示「新会话 N」，标题生成后同步
 *   - 点历史条目会向右追加 tab
 *   - 历史覆盖层分组渲染、搜索、返回都能跑通
 *
 * 用法：node test/tab-history-ui.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(HERE, '..', 'extensions', 'local.dsh-editor-bridge-0.3.0', 'media');
const src = readFileSync(join(MEDIA, 'chat.js'), 'utf8');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ? `\n      ${detail}` : ''); }
}

/** 假节点：textContent 赋值要模拟真实 DOM 的「清空所有子节点」语义。 */
function makeNode(id) {
  const node = {
    id, hidden: false, value: '', className: '', title: '',
    dataset: {}, style: {}, children: [], scrollTop: 0,
    scrollHeight: 100, clientHeight: 100, innerHeight: 800,
    appendChild(c) { this.children.push(c); return c; },
    replaceChild() {}, addEventListener(type, cb) { this._handlers ??= {}; this._handlers[type] = cb; },
    removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, closest() { return null; }, focus() {}, scrollIntoView() {},
    fire(type, event = {}) { this._handlers?.[type]?.(event); },
  };
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); node.children = []; },
  });
  return node;
}

const nodes = new Map();
for (const id of [
  'log', 'input', 'send', 'stop', 'error', 'tabs', 'new', 'history', 'history-overlay',
  'history-back', 'history-refresh', 'history-q', 'history-list', 'history-empty', 'history-error',
  'ctxinfo', 'hint', 'empty',
]) nodes.set(id, makeNode(id));
// HTML 里 history-overlay 带 hidden 属性，初始就是收起的
nodes.get('history-overlay').hidden = true;

const posted = [];
const sandbox = {
  document: {
    getElementById: (id) => nodes.get(id) || makeNode(id),
    createElement: () => makeNode('el'),
    createTextNode: (t) => makeNode('text'),
    createDocumentFragment: () => makeNode('frag'),
    createTreeWalker: () => ({ nextNode: () => false, currentNode: null }),
    NodeFilter: { SHOW_TEXT: 4 },
    addEventListener() {},
  },
  window: {
    DshMarkdown: { render: (s) => s },
    addEventListener(ev, cb) { if (ev === 'message') sandbox.__onMessage = cb; },
    requestAnimationFrame: (cb) => { cb(); return 1; },
    prompt: () => '重命名后的标题',
    innerHeight: 800,
  },
  navigator: { clipboard: { writeText: async () => {} } },
  acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
  console,
  __onMessage: null,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const emit = (msg) => sandbox.__onMessage?.({ data: msg });
const tabTexts = () => nodes.get('tabs').children.map((t) => t.children?.[0]?.textContent || '');

console.log('tab 条：向右追加 + 不显示 id');
{
  emit({ type: 'state', sessionId: 'session-abc-123', sessionTitle: '', messages: [], busy: false });
  const texts = tabTexts();
  check('新建会话产生 1 个 tab', texts.length === 1, JSON.stringify(texts));
  check('无标题显示「新会话 1」', texts[0] === '新会话 1', texts[0]);
  check('tab 不泄露会话 id', !texts[0].includes('session') && !texts[0].includes('abc-123'), texts[0]);
}

console.log('标题生成后同步到 tab');
{
  emit({ type: 'sessions', items: [{ id: 'session-abc-123', title: '修复登录' }] });
  const texts = tabTexts();
  check('tab 显示真实标题', texts[0] === '修复登录', JSON.stringify(texts));
  check('仍不泄露 id', !texts[0].includes('session'), texts[0]);
}

console.log('点历史条目：向右追加 tab');
{
  emit({ type: 'state', sessionId: 'session-old-999', sessionTitle: '旧会话标题', messages: [], busy: false });
  const texts = tabTexts();
  check('tab 数量变为 2', texts.length === 2, JSON.stringify(texts));
  check('新 tab 用历史带来的标题', texts[1] === '旧会话标题', texts[1]);
  check('当前 tab 被标记 active',
    nodes.get('tabs').children[1].dataset.active === 'true',
    JSON.stringify(nodes.get('tabs').children.map((t) => t.dataset.active)));
}

console.log('历史覆盖层：按钮打开 / 返回 / 搜索');
{
  const overlay = nodes.get('history-overlay');
  check('初始隐藏', overlay.hidden === true);
  nodes.get('history').fire('click');
  check('点时钟按钮后显示', overlay.hidden === false);
  check('打开时请求全量会话',
    posted.some((m) => m.type === 'listSessions' && m.all === true));

  nodes.get('history-q').value = '登录';
  // 直接触发 input 回调（定时器在假环境里不好跑，验证回调存在即可）
  check('搜索框绑定了 input', Boolean(nodes.get('history-q')._handlers?.input));

  emit({ type: 'allSessions', items: [
    { id: 'x', title: '今天的', updatedAt: Date.now() },
    { id: 'y', title: '很久以前', updatedAt: Date.now() - 30 * 86400000 },
  ] });
  check('历史列表渲染出分组与条目', nodes.get('history-list').children.length >= 3,
    String(nodes.get('history-list').children.length));

  nodes.get('history-back').fire('click');
  check('点返回后收起', overlay.hidden === true);
}

console.log('消息协议');
{
  const types = new Set(posted.map((m) => m.type));
  check('启动会发 ready', types.has('ready'));
  // 模拟点新建 / 点历史条目
  nodes.get('new').fire('click');
  nodes.get('history-list').children[1]?.fire?.('click');
  check('新建发 newChat', posted.some((m) => m.type === 'newChat'));
}

console.log('本轮改动卡片');
{
  /** 深度收集所有后代的 className 与文本，便于断言结构。 */
  const walk = (node, out = []) => {
    for (const child of node.children || []) {
      out.push(child);
      walk(child, out);
    }
    return out;
  };

  const changesPart = {
    type: 'changes', seq: 27, turn: 1, added: 18, deleted: 3, total: 2, files: [
      { path: '/repo/a/sessions.js', display: 'sessions.js', added: 12, deleted: 2 },
      { path: '/repo/a/icon.png', display: 'icon.png', added: 0, deleted: 0, binary: true },
    ],
  };
  emit({
    type: 'state', sessionId: 'session-abc-123', sessionTitle: '带改动的会话',
    messages: [{ role: 'assistant', parts: [changesPart], reasoning: '' }],
    busy: false,
  });

  const all = walk(nodes.get('log'));
  const card = all.find((n) => n.className === 'changes');
  check('渲染出 changes 卡片', Boolean(card));
  const title = all.find((n) => n.className === 'changes-title');
  check('标题显示文件数', title?.textContent === '本轮改动 2 个文件', title?.textContent);
  const stat = all.find((n) => n.className === 'changes-stat');
  check('统计显示增删行数', stat?.textContent === '+18 −3', stat?.textContent);

  const rows = all.filter((n) => n.className === 'changes-row');
  check('每个文件一行', rows.length === 2, String(rows.length));
  check('行带 seq/index', rows[0]?.dataset?.seq === '27' && rows[0]?.dataset?.index === '0');
  check('行带 openChangeDiff 动作', rows[0]?.dataset?.act === 'openChangeDiff');
  const fileNames = all.filter((n) => n.className === 'changes-file').map((n) => n.textContent);
  check('显示的是 display 名而非绝对路径', fileNames[0] === 'sessions.js', fileNames[0]);
  const deltas = all.filter((n) => n.className === 'changes-delta').map((n) => n.textContent);
  check('普通文件显示 +/−', deltas[0] === '+12 −2', deltas[0]);
  check('二进制文件显示「二进制」', deltas[1] === '二进制', deltas[1]);

  // 点某行 → 发 openChangeDiff，且带上当前会话 id
  // 真实 DOM 里 click 会冒泡到 #log（事件委托在 chat.js 上）；
  // 假 DOM 不冒泡，所以直接把带 target 的事件派给 #log。
  const before = posted.length;
  nodes.get('log').fire('click', {
    target: { closest: (sel) => (String(sel).includes('data-act') ? rows[1] : null) },
  });
  const sent = posted.slice(before).find((m) => m.type === 'openChangeDiff');
  check('点击发 openChangeDiff', Boolean(sent));
  check('消息带 sessionId', sent?.sessionId === 'session-abc-123', sent?.sessionId);
  check('消息带 seq/index', sent?.seq === 27 && sent?.index === 1, `${sent?.seq}/${sent?.index}`);

  // pending 与过期两种空态文案要区分
  emit({
    type: 'state', sessionId: 'session-abc-123', sessionTitle: '加载中',
    messages: [{ role: 'assistant', parts: [{ type: 'changes', seq: 28, turn: 2, pending: true, files: [] }], reasoning: '' }],
    busy: false,
  });
  const loading = walk(nodes.get('log')).find((n) => n.className === 'changes-empty');
  check('pending 显示读取中', String(loading?.textContent).includes('读取'), loading?.textContent);

  emit({
    type: 'state', sessionId: 'session-abc-123', sessionTitle: '已过期',
    messages: [{ role: 'assistant', parts: [{ type: 'changes', seq: 29, turn: 2, pending: false, files: [] }], reasoning: '' }],
    busy: false,
  });
  const expired = walk(nodes.get('log')).find((n) => n.className === 'changes-empty');
  check('过期显示已过期', String(expired?.textContent).includes('过期'), expired?.textContent);

  // 失败原因不同，文案必须不同：把「服务不存在」说成「过期」会误导排查
  const cases = [
    ['unavailable', '未提供改动记录服务'],
    ['failed', '读取改动记录失败'],
    ['none', '没有文件改动'],
    [undefined, '过期'],
  ];
  for (const [reason, expect] of cases) {
    emit({
      type: 'state', sessionId: 'session-abc-123', sessionTitle: '空态',
      messages: [{ role: 'assistant', parts: [{
        type: 'changes', seq: 40, turn: 3, pending: false, files: [],
        ...(reason ? { emptyReason: reason } : {}),
      }], reasoning: '' }],
      busy: false,
    });
    const hint = walk(nodes.get('log')).find((n) => n.className === 'changes-empty');
    check(`空态 ${reason || '(缺省)'} 文案正确`, String(hint?.textContent).includes(expect),
      hint?.textContent);
  }

  // 单个文件项异常不能炸掉整条日志（否则整个侧栏白屏）
  let crashed = null;
  try {
    emit({
      type: 'state', sessionId: 'session-abc-123', sessionTitle: '脏数据',
      messages: [{ role: 'assistant', parts: [{
        type: 'changes', seq: 30, turn: 2, total: 2, added: 1, deleted: 0,
        files: [null, { display: 'ok.js', path: '/repo/a/ok.js', added: 1, deleted: 0 }],
      }], reasoning: '' }],
      busy: false,
    });
  } catch (err) { crashed = err; }
  check('文件项为 null 时不抛错', !crashed, crashed && String(crashed.message));
  const rowsAfter = walk(nodes.get('log')).filter((n) => n.className === 'changes-row');
  check('异常项仍渲染成一行', rowsAfter.length === 2, String(rowsAfter.length));
}

console.log(failed === 0 ? 'PASS: tab 条与历史覆盖层自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);
