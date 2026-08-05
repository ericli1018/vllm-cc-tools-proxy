import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  PROGRESS_BLOCK_HEADER,
  ProgressStream,
  hasProgressHistory,
  stripProgressHistory,
} from '../src/proxy/progress.js';
import { pipeAnthropicUpstreamStream } from '../src/proxy/anthropic-sse.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headers = null;
    this.status = null;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk = '') {
    if (chunk) this.chunks.push(String(chunk));
    this.ended = true;
  }
}

test('ProgressStream emits the V0.2.6 progress header without a V0.2.2 nonce sentinel', async () => {
  assert.equal(PROGRESS_BLOCK_HEADER, '目前處理進度：');
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.update('正在解析 PDF…', { force: true });
  await progress.closeProgress('處理完成；正在回傳模型結果…');
  await progress.stop();

  const stream = response.chunks.join('');
  assert.match(stream, new RegExp(PROGRESS_BLOCK_HEADER));
  assert.match(stream, /正在解析 PDF/);
  assert.doesNotMatch(stream, /VLLMCCP:v1:/);
  assert.doesNotMatch(stream, /\u2063/);
});

test('stripProgressHistory removes a dedicated V0.2.3 progress block and keeps model blocks', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: `${PROGRESS_BLOCK_HEADER}\n正在解析 PDF…\n處理完成；正在回傳模型結果…` },
      { type: 'thinking', thinking: 'model thought', signature: 'sig' },
      { type: 'text', text: '真正答案' },
    ],
  }];
  const result = stripProgressHistory(messages);
  assert.deepEqual(result[0].content, [
    { type: 'thinking', thinking: 'model thought', signature: 'sig' },
    { type: 'text', text: '真正答案' },
  ]);
});

test('hasProgressHistory detects the dedicated V0.2.3 progress block', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: `${PROGRESS_BLOCK_HEADER}\n正在解析 PDF…` }] }];
  assert.equal(hasProgressHistory(messages), true);
});



test('stripProgressHistory removes the V0.2.5 legacy readable progress header', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: 'VLLM-CC-TOOLS-PROXY 進度：\n正在解析 PDF…\n處理完成；正在回傳模型結果…' },
      { type: 'text', text: '真正答案' },
    ],
  }];
  assert.equal(hasProgressHistory(messages), true);
  assert.deepEqual(stripProgressHistory(messages)[0].content, [{ type: 'text', text: '真正答案' }]);
});
test('stripProgressHistory removes V0.2.2 invisible sentinel region for backward compatibility', () => {
  const start = '\u2063VLLMCCP:v1:abc123:start\u2063';
  const end = '\u2063VLLMCCP:v1:abc123:end\u2063';
  const messages = [{
    role: 'assistant',
    content: [{ type: 'text', text: `${start}正在解析 PDF…${end}\n\n真正答案` }],
  }];
  const result = stripProgressHistory(messages);
  assert.equal(result[0].content[0].text, '\n\n真正答案');
});

test('stripProgressHistory removes V0.2.2 markers even when invisible separators were normalized away', () => {
  const messages = [{
    role: 'assistant',
    content: [{ type: 'text', text: 'VLLMCCP:v1:abc123:start處理完成；正在回傳模型結果…VLLMCCP:v1:abc123:end\n真正答案' }],
  }];
  const result = stripProgressHistory(messages);
  assert.equal(result[0].content[0].text, '\n真正答案');
});

test('stripProgressHistory preserves ordinary assistant text', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: '正在解析 PDF，但這是模型答案。' }] }];
  assert.deepEqual(stripProgressHistory(messages), messages);
  assert.equal(hasProgressHistory(messages), false);
});

test('closeProgress does not create a progress block when no progress became visible', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 60_000, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.closeProgress('處理完成；正在回傳模型結果…');
  await progress.stop();

  const stream = response.chunks.join('');
  assert.equal(progress.visible, false);
  assert.doesNotMatch(stream, new RegExp(PROGRESS_BLOCK_HEADER));
  assert.doesNotMatch(stream, /處理完成；正在回傳模型結果/);
  assert.doesNotMatch(stream, /event: content_block_start/);
});

test('managed keepalive continues through upstream TTFT and stops before message_stop', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 10 });
  await progress.open();
  await progress.update('正在解析 PDF…', { force: true });
  const encoder = new TextEncoder();
  const upstream = new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n')), 25);
      setTimeout(() => controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n')), 50);
      setTimeout(() => {
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      }, 75);
    },
  }), { headers: { 'content-type': 'text/event-stream' } });

  await pipeAnthropicUpstreamStream(progress, upstream);
  const stream = response.chunks.join('');
  const pingCount = (stream.match(/event: ping/g) || []).length;
  assert.ok(pingCount >= 3, `expected periodic pings, received ${pingCount}`);
  assert.match(stream, /"text":"OK"/);
  assert.ok(stream.lastIndexOf('event: ping') < stream.lastIndexOf('event: message_stop'));
  for (const line of stream.split(/\r?\n/).filter((item) => item.startsWith('data: '))) {
    assert.doesNotThrow(() => JSON.parse(line.slice(6)));
  }
});
