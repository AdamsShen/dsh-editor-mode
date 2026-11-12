/*
 * Server-Sent Events 解析（CJS，供 extension.js 与单元测试共用）。
 *
 * 只实现 DSH /editor-chat/send 产出的事件子集：`event:` + 单/多行 `data:`，
 * 以空行分隔。故意不引第三方 SSE 库：协议面很小，自带实现更容易在
 * Node 扩展主机里避免依赖冲突。
 */

'use strict';

/**
 * 解析一个完整事件块（已按空行切开）。
 * @param {string} raw 事件块原文（可含 \r）
 * @param {(event: string, payload: any) => void} onEvent 回调；JSON 解析失败时跳过
 */
function parseSseBlock(raw, onEvent) {
  let event = 'message';
  const data = [];
  for (const line of String(raw).split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim();
    else if (trimmed.startsWith('data:')) data.push(trimmed.slice(5).trim());
  }
  if (!data.length) return;
  let payload;
  try { payload = JSON.parse(data.join('\n')); } catch { return; }
  onEvent(event, payload);
}

/**
 * 造一个有状态的增量解析器：把任意切分的 chunk 拼回事件块后回调。
 * 流结束时必须调用 flush()，否则最后一个没有尾随空行的事件会丢。
 * @param {(event: string, payload: any) => void} onEvent 事件回调
 */
function createSseParser(onEvent) {
  let buffer = '';
  const drain = () => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (raw.trim()) parseSseBlock(raw, onEvent);
    }
  };
  return {
    push(chunk) {
      buffer += String(chunk);
      drain();
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest.trim()) parseSseBlock(rest, onEvent);
    },
  };
}

module.exports = { parseSseBlock, createSseParser };