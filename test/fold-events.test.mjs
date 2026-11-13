/**
 * 测试：会话事件折叠（session-view.js 的 foldEvents）。
 *
 * 为什么单独测：历史加载与实时增量**共用同一套折叠规则**，
 * 一旦两边不一致，就会出现「刚聊完」和「重新打开」显示不同的经典问题。
 *
 * 用法：node test/fold-events.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { foldEvents, summarizeToolResult, formatArgs, invertHunks, hunksMatchContent, splitLines } = require('../extensions/local.dsh-editor-bridge-0.3.0/session-view.js');

let failed = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ✓', name);
  else { failed += 1; console.log('  ✗', name, detail ? `\n      ${detail}` : ''); }
}

// 真实形状（实测 DSH 0.2.2-rc.1）：内容直接在 data.content，source.kind 区分真人输入
const userEvent = (text, kind = 'user') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind }, role: 'user' },
});
const assistantEvent = (content) => ({ type: 'assistant/message', data: { message: { content } } });

console.log('基本对话');
{
  const messages = foldEvents([userEvent('你好'), assistantEvent([{ type: 'text', text: '在的' }])]);
  check('两条消息', messages.length === 2, String(messages.length));
  check('角色正确', messages[0].role === 'user' && messages[1].role === 'assistant');
  check('用户文字', messages[0].parts[0].text === '你好');
  check('助手文字', messages[1].parts[0].text === '在的');
}

console.log('工具调用 → 卡片');
{
  const messages = foldEvents([
    userEvent('看下 README'),
    // 助手先发起工具调用（DSH 把 tool-call 放在 assistant/message 的 content 块里）
    assistantEvent([
      { type: 'text', text: '我读一下。' },
      { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } },
    ]),
    // 结果单独成事件，靠 callId 回填到同一张卡
    { type: 'tool/result', data: { message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: '# 标题' }] } } },
  ]);
  const parts = messages[1].parts;
  check('有文字 + 工具两块', parts.length === 2, JSON.stringify(parts.map((p) => p.type)));
  const tool = parts.find((p) => p.type === 'tool');
  check('工具名正确', tool.name === 'read_file');
  check('参数压成一行且含路径', tool.summary.includes('README.md'), tool.summary);
  check('结果被回填', tool.result === '# 标题', JSON.stringify(tool.result));
  check('状态从 running 转 done', tool.status === 'done', tool.status);
}

console.log('工具失败');
{
  const messages = foldEvents([
    assistantEvent([{ type: 'tool-call', id: 'c2', name: 'run', arguments: 'ls' }]),
    { type: 'tool/result', data: { message: { source: { callId: 'c2' }, isError: true, content: 'ENOENT' } } },
  ]);
  const tool = messages[0].parts.find((p) => p.type === 'tool');
  check('失败状态标 error', tool.status === 'error', tool.status);
  check('错误内容保留', tool.result === 'ENOENT');
}

console.log('turn/end 收尾');
{
  // 只有 tool/call 没有 result 时，turn 结束不能让它一直转圈
  const messages = foldEvents([
    assistantEvent([{ type: 'tool-call', id: 'c3', name: 'grep', arguments: 'TODO' }]),
    { type: 'turn/end', data: {} },
  ]);
  const tool = messages[0].parts.find((p) => p.type === 'tool');
  check('未回收的工具被标 done', tool.status === 'done', tool.status);
}

console.log('多轮与思考过程');
{
  const messages = foldEvents([
    userEvent('一'),
    assistantEvent([{ type: 'reasoning', text: '想想' }, { type: 'text', text: '一答' }]),
    userEvent('二'),
    assistantEvent([{ type: 'text', text: '二答' }]),
  ]);
  check('四段消息', messages.length === 4, String(messages.length));
  check('思考单独存字段', messages[1].reasoning === '想想', messages[1].reasoning);
  check('第二轮问题归属正确', messages[2].parts[0].text === '二');
  check('第二轮回答握在新消息里', messages[3].parts[0].text === '二答');
}

console.log('DSH 注入的伪用户消息要挡掉');
{
  // 这三种 source.kind 都是 DSH 自己塞给模型的上下文，渲染出来只会是噪音
  const messages = foldEvents([
    userEvent('真正的问题'),
    userEvent('Current runtime context...', 'runtime-context'),
    userEvent('<system-reminder>…', 'skill-catalog'),
    userEvent('Time sampled…', 'time-context'),
    assistantEvent([{ type: 'text', text: '答' }]),
  ]);
  check('只保留真人输入', messages.length === 2, String(messages.length));
  check('真人内容正确', messages[0].parts[0].text === '真正的问题');
}

console.log('容错');
{
  check('空数组', foldEvents([]).length === 0);
  check('非数组不炸', foldEvents(null).length === 0);
  check('未知事件被忽略', foldEvents([{ type: 'whatever/x', data: {} }]).length === 0);
  check('缺 data 不炸', foldEvents([{ type: 'tool/result' }]).length === 0);
  const partial = foldEvents([{ type: 'assistant/message', data: {} }]);
  check('缺 content 产生空助手消息', partial.length === 1 && partial[0].parts.length === 0);
}

console.log('辅助函数');
{
  check('超长结果被截断', summarizeToolResult('x'.repeat(9000)).includes('已截断'));
  check('短结果原样返回', summarizeToolResult('ok') === 'ok');
  check('参数对象序列化', formatArgs({ a: 1 }).includes('"a":1'));
  check('超长参数截断', formatArgs({ s: 'y'.repeat(600) }).endsWith('…'));
}

console.log('Agent 改动卡片');
{
  const msgs = foldEvents([
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改一下' }] } },
    { type: 'tool/call', data: { callId: 'c1', toolName: 'write', arguments: '{}' } },
    { type: 'workspace/changes', seq: 27, data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1 } },
  ]);
  const parts = msgs.flatMap((m) => m.parts || []);
  const card = parts.find((p) => p.type === 'changes');
  check('折叠出 changes 卡片', Boolean(card));
  check('卡片带 seq', card.seq === 27, String(card?.seq));
  check('卡片带 turn', card.turn === 1, String(card?.turn));
  check('卡片初始 pending（列表待补全）', card.pending === true);
  check('卡片初始 files 为空数组', Array.isArray(card.files) && card.files.length === 0);

  // 同一 seq 只折叠一张卡（历史里重复出现时不重复渲染）
  const dup = foldEvents([
    { type: 'workspace/changes', seq: 27, data: { turn: 1 } },
    { type: 'workspace/changes', seq: 27, data: { turn: 1 } },
  ]);
  check('同 seq 不重复出卡', dup.flatMap((m) => m.parts).filter((p) => p.type === 'changes').length === 1);

  // 非法 seq 直接跳过，不产出坏卡
  const bad = foldEvents([{ type: 'workspace/changes', data: { turn: 1 } }]);
  check('缺 seq 不出卡', bad.flatMap((m) => m.parts || []).every((p) => p.type !== 'changes'));
}

console.log('改动卡片的回合归属（事件顺序可能晚于 turn/end）');
{
  const U = (t) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: t }] } });
  const A = (t) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: t }] } } });
  const C = (seq) => ({ type: 'workspace/changes', seq, data: { turn: 1 } });
  const TE = { type: 'turn/end', data: { turn: 1 } };
  const cardOf = (msgs) => msgs.flatMap((m) => m.parts || []).find((p) => p.type === 'changes');

  // A) 正常顺序：卡片与工具/正文同一条助手消息
  const a = foldEvents([U('改文件'), A('改好了'), C(33), TE]);
  check('正常顺序：卡片与助手正文同一条', a.length === 2 && a[1].parts.some((p) => p.type === 'changes'));

  // B) 晚于 turn/end：不能多出一条只有卡片的空气泡
  const b = foldEvents([U('改文件'), A('改好了'), TE, C(33)]);
  check('晚于 turn/end 不产生空气泡', b.length === 2, JSON.stringify(b.map((m) => m.role)));
  check('晚于 turn/end 仍挂在原助手消息上',
    Boolean(b[1] && b[1].parts.some((p) => p.type === 'changes' && p.seq === 33)));

  // C) 晚到且下一轮用户消息已到：不能把上一次改动算到新一轮头上
  const c = foldEvents([U('改文件'), A('改好了'), TE, U('再改一次'), C(33)]);
  check('不挂到下一轮用户消息之后', c.length === 3, JSON.stringify(c.map((m) => m.role)));
  check('仍归属上一轮助手消息',
    Boolean(c[1] && c[1].parts.some((p) => p.type === 'changes' && p.seq === 33)));
  check('最后一轮助手消息不含该卡片',
    !(c[2] && c[2].parts.some((p) => p.type === 'changes')));

  // D) 整段没有助手消息：自建占位，且不接管后续文字
  const d = foldEvents([U('改文件'), C(34), A('后续回复')]);
  check('无助手消息时自建占位', Boolean(cardOf(d)));
  check('自建占位不吞掉后续正文',
    d.some((m) => m.parts.some((p) => p.type === 'text' && p.text === '后续回复')));
}

console.log('改动前后反推（invertHunks）');
{
  check('改一行', JSON.stringify(invertHunks(['l1', 'XYZ', 'l3'],
    [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' l1', '-abc', '+XYZ', ' l3'] }])) === '["l1","abc","l3"]');
  check('纯新增', JSON.stringify(invertHunks(['a', 'NEW', 'b'],
    [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '+NEW', ' b'] }])) === '["a","b"]');
  check('纯删除', JSON.stringify(invertHunks(['a', 'c'],
    [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, lines: [' a', '-b', ' c'] }])) === '["a","b","c"]');
  check('coarse 整文件', JSON.stringify(invertHunks(['x', 'y'],
    [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-a', '-b', '+x', '+y'] }])) === '["a","b"]');
  check('多 hunk 倒序不串位', JSON.stringify(invertHunks(['1', 'X', '3', '4', 'Y', '6'], [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' 1', '-2', '+X', ' 3'] },
    { oldStart: 4, oldLines: 3, newStart: 4, newLines: 3, lines: [' 4', '-5', '+Y', ' 6'] },
  ])) === '["1","2","3","4","5","6"]');
  check('空 hunks 原样', JSON.stringify(invertHunks(['a'], [])) === '["a"]');
  check('hunks 非数组不崩', JSON.stringify(invertHunks(['a'], null)) === '["a"]');
}

console.log('hunks 与磁盘内容一致性（防止误标本轮改动）');
{
  const hunks = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' line1', '-line2', '+changed-line', ' line3'] }];
  check('真实一致时通过', hunksMatchContent(['line1', 'changed-line', 'line3', ''], hunks) === true);
  // 该轮之后又被改过 → 必须识别出来，否则左右两栏不是同一时刻的版本
  check('磁盘漂移时拒绝', hunksMatchContent(['line1', 'NEWER-EDIT', 'line3', ''], hunks) === false);
  check('空 hunks 视为一致', hunksMatchContent(['x'], []) === true);
  check('hunks 为 null 不崩', hunksMatchContent(['x'], null) === true);
  check('newStart 非法视为不一致', hunksMatchContent(['x'], [{ newStart: 0, newLines: 1, lines: [' x'] }]) === false);
  check('行数不符视为不一致', hunksMatchContent(['x'], [{ newStart: 1, newLines: 5, lines: [' x'] }]) === false);
}

console.log('切行口径与 DSH 一致（CRLF 不能误判）');
{
  // DSH 的 lines() 等价实现：先补 \n，再 slice(0,-1).split("\n")
  const dshLines = (t) => (t === '' ? [] : (t.endsWith('\n') ? t : `${t}\n`).slice(0, -1).split('\n'));
  for (const text of ['', '\n', 'a', 'a\n', 'a\nb', 'a\nb\n', 'a\r\nb\r\n', 'a\r\nb', 'x\r\n', '\r\n']) {
    check(`切行等价 ${JSON.stringify(text)}`,
      JSON.stringify(splitLines(text)) === JSON.stringify(dshLines(text)),
      `${JSON.stringify(splitLines(text))} vs ${JSON.stringify(dshLines(text))}`);
  }

  // CRLF 文件必须能正常校验与反推（修复前会被一律拒绝）
  const crlfAfter = splitLines('a\r\nB\r\nc\r\n');
  const crlfHunks = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a\r', '-b\r', '+B\r', ' c\r'] }];
  check('CRLF 校验通过', hunksMatchContent(crlfAfter, crlfHunks) === true);
  check('CRLF 反推正确', JSON.stringify(invertHunks(crlfAfter, crlfHunks)) === JSON.stringify(['a\r', 'b\r', 'c\r']));
  check('CRLF 保留 \\r', invertHunks(crlfAfter, crlfHunks).join('\n').includes('\r'));
}

console.log(failed === 0 ? 'PASS: 折叠规则自洽' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);
