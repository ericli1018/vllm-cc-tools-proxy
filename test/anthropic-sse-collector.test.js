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
  assert.equal(completed.length, 1);
  assert.equal(completed[0].firstModelEventObserved, true);
  assert.deepEqual(completed[0].event_sequence, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(completed[0].content_block_count, 1);
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

test('V0.29.25 collector exposes only completed blocks as a recovery checkpoint while a later tool block is partial', async () => {
  const checkpoints = [];
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'recovery-1', type: 'message', role: 'assistant', model: 'mock', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Preserved text.' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-partial', name: 'Bash', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"make' } }),
  ].join('');
  const upstream = {
    ...upstreamFromChunks([]),
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(wire);
        throw new Error('simulated stalled stream abort');
      },
    },
  };

  await assert.rejects(collectAnthropicMessageFromSse(upstream, {
    onCheckpoint: async (entry) => checkpoints.push(structuredClone(entry)),
  }), /simulated stalled stream abort/);

  assert.ok(checkpoints.length >= 2);
  const last = checkpoints.at(-1);
  assert.deepEqual(last.completed_blocks, [{ type: 'text', text: 'Preserved text.' }]);
  assert.deepEqual(last.partial_block, { index: 1, type: 'tool_use', id: 'tool-partial', name: 'Bash' });
  assert.equal(last.phase, 'tool');
});

test('V0.29.31 collector emits a bounded semantic-safe SSE fingerprint for empty end_turn diagnostics', async () => {
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'empty-031', type: 'message', role: 'assistant', model: 'qwen', content: [], usage: { input_tokens: 100, output_tokens: 0 },
    } }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
  const completed = [];
  const result = await collectAnthropicMessageFromSse(upstreamFromChunks([wire]), {
    onComplete: async (entry) => completed.push(entry),
  });
  assert.deepEqual(result.content, []);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].event_sequence, ['message_start', 'message_delta', 'message_stop']);
  assert.deepEqual(completed[0].event_counts, { message_start: 1, message_delta: 1, message_stop: 1 });
  assert.equal(completed[0].content_block_count, 0);
});


test('V0.29.35 collector forwards semantic values for preview while preserving semantic byte accounting', async () => {
  const stream = [
    event('message_start', { type: 'message_start', message: { id: 'p', type: 'message', role: 'assistant', content: [], model: 'm', usage: { input_tokens: 1, output_tokens: 0 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想法一\n想法二' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '回答' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');
  const deltas = [];
  await collectAnthropicMessageFromSse(upstreamFromChunks([stream]), { onSemanticDelta: async (entry) => deltas.push(entry) });
  assert.deepEqual(deltas.map(({ type, value }) => ({ type, value })), [
    { type: 'thinking', value: '想法一\n想法二' },
    { type: 'text', value: '回答' },
  ]);
  assert.equal(deltas[0].bytes, Buffer.byteLength('想法一\n想法二', 'utf8'));
  assert.equal(deltas[1].bytes, Buffer.byteLength('回答', 'utf8'));
});

test('V0.29.39 collector preserves malformed tool diagnostics through message_delta before failing', async () => {
  const partialJson = `{"file_path":"/tmp/out.txt","content":"${'A'.repeat(1400)}`;
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm39', type: 'message', role: 'assistant', model: 'm', content: [],
      stop_reason: null, usage: { input_tokens: 123, output_tokens: 0 },
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'tool_use', id: 'tool-39', name: 'Write', input: {},
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'input_json_delta', partial_json: partialJson,
    } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: {
      stop_reason: 'max_tokens', stop_sequence: null,
    }, usage: { output_tokens: 32768 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_invalid_stream');
    assert.equal(error.details.index, 0);
    assert.equal(error.details.tool_name, 'Write');
    assert.equal(error.details.partial_json_bytes, Buffer.byteLength(partialJson, 'utf8'));
    assert.equal(error.details.partial_json_tail, partialJson.slice(-1024));
    assert.equal(error.details.stop_reason, 'max_tokens');
    assert.equal(error.details.output_tokens, 32768);
    return true;
  });
});

test('V0.29.39 malformed tool input never becomes a completed recovery checkpoint', async () => {
  const checkpoints = [];
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm39-checkpoint', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'tool_use', id: 'tool-39-checkpoint', name: 'Write', input: {},
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'input_json_delta', partial_json: '{"file_path":"/tmp/x","content":"unfinished',
    } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 32768 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire]), {
    onCheckpoint: async (snapshot) => checkpoints.push(snapshot),
  }), /malformed tool input JSON/i);

  assert.equal(checkpoints.some((snapshot) => snapshot.completed_blocks.some((block) => block.id === 'tool-39-checkpoint')), false);
  assert.equal(checkpoints.at(-1)?.partial_block?.id, 'tool-39-checkpoint');
});

test('V0.29.51 collector aborts a sustained Bash tool-input cycle before max_tokens truncation', async () => {
  const cycle = 'docs/10-quality/TIME_SYNC.md docs/10-quality/BACKUP_RESTORE.md docs/10-quality/CONFIGURATION_VERSIONING.md docs/10-quality/OBSERVABILITY.md docs/10-quality/OTA_ARCHITECTURE.md docs/10-quality/NFR.md docs/10-quality/FAULT_TOLERANCE.md docs/10-quality/OFFLINE_OPERATION.md ';
  const first = `{"command":"${cycle.repeat(36)}`;
  const second = cycle.repeat(24);
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm51-loop', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: {
      type: 'tool_use', id: 'tool-51-loop', name: 'Bash', input: {},
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: {
      type: 'input_json_delta', partial_json: first,
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: {
      type: 'input_json_delta', partial_json: second,
    } }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_tool_input_loop_detected');
    assert.equal(error.details.index, 2);
    assert.equal(error.details.tool_name, 'Bash');
    assert.equal(error.details.confirmation_stage, 'sustained');
    assert.ok(error.details.confirmed_growth_bytes >= 4096);
    assert.ok(error.details.partial_json_bytes >= 8192);
    return true;
  });
});

test('V0.29.49 collector does not classify a bounded fourfold repeated tool payload as a generation loop', async () => {
  const longTokens = Array.from({ length: 16 }, (_, i) => `segment_${i}_${'x'.repeat(180)}`).join(' ');
  const command = `${longTokens} ${longTokens} ${longTokens} ${longTokens}`;
  const json = JSON.stringify({ command });
  assert.ok(Buffer.byteLength(json, 'utf8') >= 8192);
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm49-bounded-repeat', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'tool_use', id: 'tool-49-bounded-repeat', name: 'Bash', input: {},
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'input_json_delta', partial_json: json,
    } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3000 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  const result = await collectAnthropicMessageFromSse(upstreamFromChunks([wire]));
  assert.equal(result.content[0].name, 'Bash');
  assert.equal(result.content[0].input.command, command);
});

test('V0.29.51 collector aborts a sustained thinking repetition loop before max_tokens', async () => {
  const cycle = 'I need to inspect the state, compare the evidence, decide the next action, and verify the result. ';
  const first = cycle.repeat(180);
  const second = cycle.repeat(80);
  assert.ok(Buffer.byteLength(first, 'utf8') >= 16000);
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm51-thinking-loop', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'thinking', thinking: '',
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'thinking_delta', thinking: first,
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'thinking_delta', thinking: second,
    } }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_thinking_loop_detected');
    assert.equal(error.details.index, 0);
    assert.equal(error.details.stream_kind, 'thinking');
    assert.equal(error.details.confirmation_stage, 'sustained');
    assert.ok(error.details.confirmed_growth_bytes >= 4096);
    return true;
  });
});

test('V0.29.51 collector aborts a sustained visible response repetition loop before max_tokens', async () => {
  const cycle = 'The result is complete. I will now summarize the same conclusion and provide the next step. ';
  const first = cycle.repeat(150);
  const second = cycle.repeat(70);
  assert.ok(Buffer.byteLength(first, 'utf8') >= 12000);
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm51-response-loop', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'text', text: '',
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'text_delta', text: first,
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'text_delta', text: second,
    } }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_response_loop_detected');
    assert.equal(error.details.index, 0);
    assert.equal(error.details.stream_kind, 'response');
    assert.equal(error.details.confirmation_stage, 'sustained');
    assert.ok(error.details.confirmed_growth_bytes >= 4096);
    return true;
  });
});

test('V0.29.49 collector does not classify a bounded repeated response template as a loop', async () => {
  const cycle = Array.from({ length: 18 }, (_, i) => `section_${i}_${'x'.repeat(90)}`).join(' ');
  const text = `${cycle}\n${cycle}\n${cycle}\n`;
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm49-response-bounded', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'text', text: '',
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'text_delta', text,
    } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1500 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  const result = await collectAnthropicMessageFromSse(upstreamFromChunks([wire]));
  assert.equal(result.content[0].text, text);
});

test('V0.29.51 response repetition is only suspicious until the same cycle keeps growing', async () => {
  const card = `<section><h2>Feature Card</h2><p>${'x'.repeat(180)}</p></section>`;
  const repeatedHtml = card.repeat(60);
  assert.ok(Buffer.byteLength(repeatedHtml, 'utf8') >= 12000);
  const footer = '<footer>Finished rendering the page.</footer>';
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm51-response-suspicious', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'text', text: '',
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'text_delta', text: repeatedHtml,
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'text_delta', text: footer,
    } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5000 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  const result = await collectAnthropicMessageFromSse(upstreamFromChunks([wire]));
  assert.equal(result.content[0].text, repeatedHtml + footer);
});

test('V0.29.51 thinking repetition is only suspicious until sustained growth confirms the loop', async () => {
  const cycle = `Inspect the state, compare the evidence, choose the next action, and verify it carefully ${'x'.repeat(120)}. `;
  const suspicious = cycle.repeat(100);
  assert.ok(Buffer.byteLength(suspicious, 'utf8') >= 16000);
  const uniqueConclusion = 'The evidence now differs, so I will proceed with the implementation instead of repeating the analysis.';
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm51-thinking-suspicious', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'thinking', thinking: '',
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'thinking_delta', thinking: suspicious,
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'thinking_delta', thinking: uniqueConclusion,
    } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6000 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  const result = await collectAnthropicMessageFromSse(upstreamFromChunks([wire]));
  assert.equal(result.content[0].thinking, suspicious + uniqueConclusion);
});

for (const toolName of ['Write', 'Edit', 'NotebookEdit']) {
  test(`V0.29.51 ${toolName} allows large repeated generated content when repetition stops`, async () => {
    const card = `<section><h2>Feature Card</h2><p>${'x'.repeat(180)}</p></section>`;
    const generated = card.repeat(160);
    assert.ok(Buffer.byteLength(generated, 'utf8') >= 32000);
    const prefix = '{"file_path":"/tmp/page.html","content":"';
    const suffix = '<footer>unique-finish</footer>"}';
    const fullJson = prefix + generated + suffix;
    const wire = [
      event('message_start', { type: 'message_start', message: {
        id: `m51-${toolName}`, type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
      } }),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
        type: 'tool_use', id: `tool-51-${toolName}`, name: toolName, input: {},
      } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
        type: 'input_json_delta', partial_json: prefix + generated,
      } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
        type: 'input_json_delta', partial_json: suffix,
      } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12000 } }),
      event('message_stop', { type: 'message_stop' }),
    ].join('');

    const result = await collectAnthropicMessageFromSse(upstreamFromChunks([wire]));
    assert.equal(result.content[0].name, toolName);
    assert.deepEqual(result.content[0].input, JSON.parse(fullJson));
  });
}

test('V0.29.51 Bash aborts only after the same repeated cycle persists across later stream growth', async () => {
  const cycle = `docs/10-quality/TIME_SYNC.md docs/10-quality/BACKUP_RESTORE.md docs/10-quality/CONFIGURATION_VERSIONING.md docs/10-quality/OBSERVABILITY.md docs/10-quality/OTA_ARCHITECTURE.md docs/10-quality/NFR.md docs/10-quality/FAULT_TOLERANCE.md docs/10-quality/OFFLINE_OPERATION.md `;
  const prefix = '{"command":"';
  const first = prefix + cycle.repeat(36);
  const second = cycle.repeat(24);
  assert.ok(Buffer.byteLength(first, 'utf8') >= 8192);
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm51-bash-sustained', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'tool_use', id: 'tool-51-bash-sustained', name: 'Bash', input: {},
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'input_json_delta', partial_json: first,
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'input_json_delta', partial_json: second,
    } }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_tool_input_loop_detected');
    assert.equal(error.details.tool_name, 'Bash');
    assert.equal(error.details.confirmation_stage, 'sustained');
    assert.ok(error.details.confirmed_growth_bytes >= 2048);
    return true;
  });
});

test('V0.29.51 Write still aborts when generated-content repetition keeps growing after suspicion', async () => {
  const card = `<section><h2>Feature Card</h2><p>${'x'.repeat(180)}</p></section>`;
  const prefix = '{"file_path":"/tmp/page.html","content":"';
  const first = prefix + card.repeat(160);
  const second = card.repeat(45);
  assert.ok(Buffer.byteLength(first, 'utf8') >= 32768);
  assert.ok(Buffer.byteLength(second, 'utf8') >= 8192);
  const wire = [
    event('message_start', { type: 'message_start', message: {
      id: 'm51-write-sustained', type: 'message', role: 'assistant', model: 'm', content: [], usage: {},
    } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: {
      type: 'tool_use', id: 'tool-51-write-sustained', name: 'Write', input: {},
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'input_json_delta', partial_json: first,
    } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
      type: 'input_json_delta', partial_json: second,
    } }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_tool_input_loop_detected');
    assert.equal(error.details.tool_name, 'Write');
    assert.equal(error.details.detector_profile, 'generated_content');
    assert.equal(error.details.confirmation_stage, 'sustained');
    assert.ok(error.details.confirmed_growth_bytes >= 8192);
    return true;
  });
});
