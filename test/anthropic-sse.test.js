import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeAnthropicUpstreamStream } from '../src/proxy/anthropic-sse.js';

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test('managed Anthropic stream diagnoses split control tags without rewriting upstream text', async () => {
  const chunks = [
    event('message_start', { type: 'message_start' }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x </func' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'tion_result> y' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '<tool_call>' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('message_stop', { type: 'message_stop' }),
  ];
  const writes = [];
  const diagnostics = [];
  const progress = {
    visible: false,
    closeProgress: async () => {},
    writeRaw: async (value) => writes.push(value),
    stopKeepalive: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  const upstream = { body: Readable.from(chunks.map((chunk) => Buffer.from(chunk))) };
  await pipeAnthropicUpstreamStream(progress, upstream, {
    onDiagnostic: (eventName, details) => diagnostics.push({ eventName, details }),
  });
  assert.match(writes.join(''), /<tool_call>/);
  assert.match(writes.join(''), /<\/func/);
  assert.match(writes.join(''), /tion_result>/);
  assert.deepEqual(diagnostics, [{
    eventName: 'base_generation_control_tags_detected',
    details: {
      tagCount: 2,
      tags: ['function_result', 'tool_call'],
      channels: ['thinking', 'text'],
    },
  }]);
});
