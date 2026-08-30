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

test('V0.29.35 collector captures bounded malformed tool JSON shape diagnostics without repairing it', async () => {
  const pieces = ['{\"command\":\"echo one\"}', '{\"command\":', '\"echo two\"}'];
  const partialJson = pieces.join('');
  const wire = [
    event('message_start', { type: 'message_start', message: { id: 'diag-m', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-diag', name: 'Bash', input: {} } }),
    ...pieces.map((partial_json) => event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_invalid_stream');
    assert.equal(error.details?.kind, 'tool_input_json_invalid');
    assert.equal(error.details?.index, 0);
    assert.equal(error.details?.tool_id, 'tool-diag');
    assert.equal(error.details?.tool_name, 'Bash');
    assert.equal(error.details?.partial_json_chars, partialJson.length);
    assert.equal(error.details?.partial_json_bytes, Buffer.byteLength(partialJson, 'utf8'));
    assert.equal(error.details?.partial_json_delta_count, 3);
    assert.equal(error.details?.partial_json_starts_with_object, true);
    assert.equal(error.details?.partial_json_ends_with_object, true);
    assert.equal(error.details?.candidate_top_level_objects, 2);
    assert.equal(Number.isInteger(error.details?.json_error_position), true);
    assert.equal(error.details?.partial_json_prefix, partialJson);
    assert.equal(error.details?.partial_json_suffix, partialJson);
    assert.equal(error.details?.partial_json_preview_chars <= 512, true);
    return true;
  });
});

test('V0.29.35 malformed tool JSON previews stay bounded for large tool arguments', async () => {
  const partialJson = `{\"command\":\"${'x'.repeat(4000)}\"}{\"command\":\"tail\"}`;
  const wire = [
    event('message_start', { type: 'message_start', message: { id: 'diag-large', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-large', name: 'Bash', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.details?.partial_json_prefix.length <= 512, true);
    assert.equal(error.details?.partial_json_suffix.length <= 512, true);
    assert.equal(error.details?.partial_json_chars, partialJson.length);
    assert.equal(error.details?.candidate_top_level_objects, 2);
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

test('V0.29.36 collector quarantines malformed tool JSON after content_block_stop and captures a late same-index closing delta', async () => {
  const partialJson = '{"file_path":"/tmp/report.md"';
  const lateJson = '}';
  const wire = [
    event('message_start', { type: 'message_start', message: { id: 'post-stop-late', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-late', name: 'Read', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: partialJson } }),
    event('content_block_stop', { type: 'content_block_stop', index: 2 }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: lateJson } }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.code, 'vllm_invalid_stream');
    assert.equal(error.details?.kind, 'tool_input_json_invalid');
    assert.equal(error.details?.index, 2);
    assert.equal(error.details?.tool_name, 'Read');
    assert.equal(error.details?.post_stop_probe_stop_reason, 'message_stop');
    assert.equal(error.details?.post_stop_probe_event_count, 3);
    assert.deepEqual(error.details?.post_stop_probe_event_sequence, ['content_block_delta', 'message_delta', 'message_stop']);
    assert.equal(error.details?.late_same_index_input_json_delta_count, 1);
    assert.equal(error.details?.late_same_index_partial_json_chars, 1);
    assert.equal(error.details?.late_same_index_partial_json_prefix, '}');
    assert.equal(error.details?.late_same_index_partial_json_suffix, '}');
    assert.equal(error.details?.late_same_index_combined_json_valid, true);
    return true;
  });
});

test('V0.29.36 collector distinguishes message_stop with no late tool JSON delta', async () => {
  const wire = [
    event('message_start', { type: 'message_start', message: { id: 'post-stop-none', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-none', name: 'Read', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/report.md"' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.details?.post_stop_probe_stop_reason, 'message_stop');
    assert.equal(error.details?.post_stop_probe_event_count, 2);
    assert.deepEqual(error.details?.post_stop_probe_event_sequence, ['message_delta', 'message_stop']);
    assert.equal(error.details?.late_same_index_input_json_delta_count, 0);
    assert.equal(error.details?.late_same_index_partial_json_chars, 0);
    assert.equal(error.details?.late_same_index_combined_json_valid, false);
    return true;
  });
});

test('V0.29.37 post-stop probe is bounded by 64 trailing SSE events when message_stop never arrives', async () => {
  const trailing = Array.from({ length: 80 }, (_, i) => event('ping', { type: 'ping', n: i }));
  const wire = [
    event('message_start', { type: 'message_start', message: { id: 'post-stop-bound', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-bound', name: 'Read', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/report.md"' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ...trailing,
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.details?.post_stop_probe_stop_reason, 'event_limit');
    assert.equal(error.details?.post_stop_probe_event_count, 64);
    assert.equal(error.details?.late_same_index_input_json_delta_count, 0);
    return true;
  });
});

test('V0.29.37 post-stop probe is bounded by 16384 trailing raw bytes', async () => {
  const oversized = event('content_block_delta', {
    type: 'content_block_delta', index: 7,
    delta: { type: 'text_delta', text: 'x'.repeat(17000) },
  });
  const wire = [
    event('message_start', { type: 'message_start', message: { id: 'post-stop-byte-bound', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-byte-bound', name: 'Read', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/report.md"' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    oversized,
  ].join('');

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([wire])), (error) => {
    assert.equal(error.details?.post_stop_probe_stop_reason, 'byte_limit');
    assert.equal(error.details?.post_stop_probe_event_count, 1);
    assert.equal(error.details?.post_stop_probe_raw_bytes >= 16384, true);
    return true;
  });
});


test('V0.29.37 post-stop probe drains across later blocks to message_stop and captures bounded lifecycle metadata', async () => {
  const malformed = '{"query":"top world news"';
  const events = [
    event('message_start', { type: 'message_start', message: { id: 'post-stop-lifecycle', type: 'message', role: 'assistant', model: 'm', content: [], usage: {} } }),
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-search-2', name: 'WebSearch', input: {} } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: malformed } }),
    event('content_block_stop', { type: 'content_block_stop', index: 2 }),
  ];
  // Eight events are intentionally placed before the late same-index closing brace.
  for (let index = 3; index <= 4; index += 1) {
    events.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `tool-${index}`, name: 'Read', input: {} } }));
    events.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: `{"file_path":"/tmp/${index}.md"}` } }));
    events.push(event('content_block_stop', { type: 'content_block_stop', index }));
  }
  events.push(event('content_block_start', { type: 'content_block_start', index: 5, content_block: { type: 'text', text: '' } }));
  events.push(event('content_block_delta', { type: 'content_block_delta', index: 5, delta: { type: 'text_delta', text: 'continuing' } }));
  events.push(event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '}' } }));
  events.push(event('content_block_stop', { type: 'content_block_stop', index: 5 }));
  events.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }));
  events.push(event('message_stop', { type: 'message_stop' }));

  await assert.rejects(collectAnthropicMessageFromSse(upstreamFromChunks([events.join('')])), (error) => {
    assert.equal(error.code, 'vllm_invalid_stream');
    assert.equal(error.details?.post_stop_probe_stop_reason, 'message_stop');
    assert.equal(error.details?.late_same_index_input_json_delta_count, 1);
    assert.equal(error.details?.late_same_index_partial_json_prefix, '}');
    assert.equal(error.details?.late_same_index_combined_json_valid, true);
    assert.equal(error.details?.post_stop_probe_event_count > 8, true);
    assert.equal(error.details?.post_stop_probe_max_events, 64);
    assert.equal(error.details?.post_stop_probe_max_raw_bytes, 16384);
    const lifecycle = error.details?.post_stop_probe_event_metadata;
    assert.ok(Array.isArray(lifecycle));
    assert.equal(lifecycle.length, error.details?.post_stop_probe_event_count);
    assert.deepEqual(lifecycle[0], {
      event: 'content_block_start', index: 3, block_type: 'tool_use', tool_name: 'Read', tool_id: 'tool-3',
    });
    assert.deepEqual(lifecycle[1], {
      event: 'content_block_delta', index: 3, delta_type: 'input_json_delta', partial_json_chars: 25,
    });
    const late = lifecycle.find((entry) => entry.event === 'content_block_delta' && entry.index === 2);
    assert.deepEqual(late, {
      event: 'content_block_delta', index: 2, delta_type: 'input_json_delta', partial_json_chars: 1,
    });
    assert.equal(lifecycle.at(-1)?.event, 'message_stop');
    return true;
  });
});
