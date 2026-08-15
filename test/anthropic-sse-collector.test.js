import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAnthropicMessageFromSse } from '../src/proxy/anthropic-sse-collector.js';

function upstreamFromChunks(chunks, contentType = 'text/event-stream; charset=utf-8') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? contentType : null },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield Buffer.from(chunk);
      },
    },
  };
}

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test('V0.2.25.1 collector reconstructs Anthropic thinking text tool input usage and stop state across arbitrary chunks', async () => {
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'msg-1', type: 'message', role: 'assistant', model: 'laguna', content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 123, output_tokens: 0, cache_read_input_tokens: 7 },
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check ' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Searching' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":"today' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' news"}' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 2 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
  const cut1 = 37;
  const cut2 = 211;
  const result = await collectAnthropicMessageFromSse(upstreamFromChunks([
    wire.slice(0, cut1), wire.slice(cut1, cut2), wire.slice(cut2),
  ]));

  assert.equal(result.id, 'msg-1');
  assert.equal(result.model, 'laguna');
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.usage.input_tokens, 123);
  assert.equal(result.usage.cache_read_input_tokens, 7);
  assert.equal(result.usage.output_tokens, 42);
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: 'check ', signature: 'sig' },
    { type: 'text', text: 'Searching' },
    { type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: { query: 'today news' } },
  ]);
});

test('V0.2.25.1 collector rejects malformed tool input JSON', async () => {
  const wire = [
    event('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'WebSearch', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{bad' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_invalid_stream');
    return true;
  });
});

test('V0.2.25.1 collector surfaces Anthropic SSE error events as retryable upstream errors', async () => {
  const wire = event('error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'overloaded_error');
    assert.equal(error.message, 'busy');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('V0.2.26.4 collector preserves first-event usage and completion callbacks while buffering final message', async () => {
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm4', type: 'message', role: 'assistant', model: 'laguna', content: [],
      stop_reason: null, usage: { input_tokens: 321, output_tokens: 0 },
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Final answer' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
  const first = [];
  const usages = [];
  const completed = [];
  const result = await collectAnthropicMessageFromSse(upstreamFromChunks([wire]), {
    onFirstEvent: async (entry) => first.push(entry),
    onUsage: async (entry) => usages.push(entry),
    onComplete: async (entry) => completed.push(entry),
  });

  assert.equal(result.content[0].text, 'Final answer');
  assert.deepEqual(first, [{ event: 'content_block_start', type: 'content_block_start', block_type: 'text' }]);
  assert.equal(usages.length, 2);
  assert.equal(usages[0].stage, 'message_start');
  assert.equal(usages[0].usage.input_tokens, 321);
  assert.equal(usages[1].stage, 'message_delta');
  assert.equal(usages[1].usage.output_tokens, 9);
  assert.deepEqual(completed, [{ firstModelEventObserved: true }]);
});

test('V0.2.28.7 collector reports meaningful stream phase transitions once', async () => {
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'phase-1', type: 'message', role: 'assistant', model: 'laguna', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'working' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 2 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
  const phases = [];

  await collectAnthropicMessageFromSse(upstreamFromChunks([wire]), {
    onStreamPhase: async (entry) => phases.push(entry),
  });

  assert.deepEqual(phases.map((entry) => entry.phase), ['thinking', 'response', 'tool']);
  assert.equal(phases[0].previous_phase, 'waiting');
  assert.equal(phases[1].previous_phase, 'thinking');
  assert.equal(phases[2].previous_phase, 'response');
  assert.equal(phases[0].block_type, 'thinking');
  assert.equal(phases[1].block_type, 'text');
  assert.equal(phases[2].block_type, 'tool_use');
});

test('V0.2.28.17 collector reports only semantic model delta bytes', async () => {
  const thinking = '分析中';
  const text = 'DONE';
  const toolJson = '{"query":"Laguna"}';
  const signature = 'not-user-visible-signature';
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'semantic-1', type: 'message', role: 'assistant', model: 'laguna', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: toolJson } }),
    event('content_block_stop', { type: 'content_block_stop', index: 2 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
  const deltas = [];

  await collectAnthropicMessageFromSse(upstreamFromChunks([wire]), {
    onSemanticDelta: async (entry) => deltas.push(entry),
  });

  assert.deepEqual(deltas.map((entry) => entry.type), ['thinking', 'text', 'tool_json']);
  assert.deepEqual(deltas.map((entry) => entry.bytes), [
    Buffer.byteLength(thinking, 'utf8'),
    Buffer.byteLength(text, 'utf8'),
    Buffer.byteLength(toolJson, 'utf8'),
  ]);
  assert.equal(deltas.reduce((sum, entry) => sum + entry.bytes, 0),
    Buffer.byteLength(thinking + text + toolJson, 'utf8'));
  assert.equal(deltas.some((entry) => entry.bytes === Buffer.byteLength(signature, 'utf8')), false);
});
