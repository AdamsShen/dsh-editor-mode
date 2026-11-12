/**
 * 测试：SSE 解析（扩展侧 sse.js）。
 *
 * 真实风险是「chunk 切分边界」和「没有尾随空行的最后一条事件」，
 * 这两种在流式回答里几乎必然出现，所以按字节级切片逐一验证。
 *
 * 用法：node test/sse.test.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseSseBlock, createSseParser } = require(
  join(HERE, '..', 'extensions', 'local.dsh-editor-bridge-0.3.0', 'sse.js'),
);

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ✓', name);
  } else {
    failed += 1;
    console.log('  ✗', name, detail ? `\n      ${detail}` : '');
  }
}

/** 收集事件的小工具。 */
function collector() {
  const events = [];
  return { events, onEvent: (event, data) => events.push([event, data]) };
}

console.log('parseSseBlock');
{
  const { events, onEvent } = collector();
  parseSseBlock('event: delta\ndata: {"text":"你好"}', onEvent);
  check('单事件', events.length === 1 && events[0][0] === 'delta' && events[0][1].text === '你好');
}
{
  const { events, onEvent } = collector();
  parseSseBlock('event: x\r\ndata: {"a":1}\r', onEvent);
  check('容忍 CRLF', events.length === 1 && events[0][1].a === 1);
}
{
  const { events, onEvent } = collector();
  parseSseBlock('event: x\ndata: {"a":\ndata: 2}', onEvent);
  check('多行 data 拼接成合法 JSON', events.length === 1 && events[0][1].a === 2);
}
{
  const { events, onEvent } = collector();
  parseSseBlock('event: x\ndata: 不是JSON', onEvent);
  check('非法 JSON 静默跳过', events.length === 0);
}
{
  const { events, onEvent } = collector();
  parseSseBlock('event: x\n: 注释行\n', onEvent);
  check('无 data 的事件跳过', events.length === 0);
}

console.log('createSseParser：流式切分');
const full = [
  'event: meta\ndata: {"requestId":"r1","provider":"p","model":"m"}\n\n',
  'event: delta\ndata: {"text":"A"}\n\n',
  'event: delta\ndata: {"text":"B"}\n\n',
  'event: reasoning\ndata: {"text":"想一想"}\n\n',
  'event: finish\ndata: {"kind":"stop"}\n\n',
].join('');

{
  // 按 1 字节切片：最坏情况的边界
  const { events, onEvent } = collector();
  const parser = createSseParser(onEvent);
  for (const ch of full) parser.push(ch);
  parser.flush();
  check('逐字节切片仍得到 5 个事件', events.length === 5, JSON.stringify(events));
  check('事件顺序正确',
    events.map((e) => e[0]).join(',') === 'meta,delta,delta,reasoning,finish',
    events.map((e) => e[0]).join(','));
  check('delta 文本完整',
    events.filter((e) => e[0] === 'delta').map((e) => e[1].text).join('') === 'AB');
}
{
  // 按 7 字节切片（跨 event: 与 data: 行）
  const { events, onEvent } = collector();
  const parser = createSseParser(onEvent);
  for (let i = 0; i < full.length; i += 7) parser.push(full.slice(i, i + 7));
  parser.flush();
  check('按 7 字节切片得到 5 个事件', events.length === 5, String(events.length));
}
{
  // 最后一条事件没有尾随空行：必须靠 flush 补上
  const { events, onEvent } = collector();
  const parser = createSseParser(onEvent);
  parser.push('event: delta\ndata: {"text":"尾部"}');
  check('未 flush 时不会提前产出', events.length === 0);
  parser.flush();
  check('flush 后拿到最后一条', events.length === 1 && events[0][1].text === '尾部');
}
{
  // CRLF 分隔
  const { events, onEvent } = collector();
  const parser = createSseParser(onEvent);
  parser.push('event: a\r\ndata: {"n":1}\r\n\r\nevent: b\r\ndata: {"n":2}\r\n\r\n');
  parser.flush();
  check('CRLF 分隔两个事件', events.length === 2 && events[1][1].n === 2);
}

console.log(failed === 0 ? 'PASS: SSE 解析全部通过' : `FAIL: ${failed} 项失败`);
process.exit(failed ? 1 : 0);