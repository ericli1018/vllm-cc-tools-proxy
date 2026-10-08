import test from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIRequest, toAnthropicMessage, adaptOpenAIResponse, approximateTokenCount } from '../src/services/openai-upstream-adapter.js';

test('maps assistant tool use and user tool results', () => {
  const data = toOpenAIRequest({ model: 'm', system: 'policy', messages: [
    { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call1', name: 'search', input: { q: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'ok' }, { type: 'text', text: 'continue' }] },
  ], tools: [{ name: 'search', input_schema: { type: 'object' } }] });
  assert.equal(data.messages[0].role, 'system');
  assert.equal(data.messages[1].tool_calls[0].function.arguments, '{"q":1}');
  assert.equal(data.messages[2].tool_call_id, 'call1');
  assert.equal(data.messages[3].role, 'user');
  assert.equal(data.tools[0].function.name, 'search');
});

test('maps OpenAI final answer and tool call', () => {
  const result = toAnthropicMessage({ id: 'x', choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'a', function: { name: 'run', arguments: '{"n":2}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0].input, { n: 2 });
  assert.equal(result.usage.input_tokens, 12);
});

test('adapts OpenAI streaming tool chunks to parseable Anthropic SSE', async () => {
  const events = [
    { id: 'chat1', model: 'm', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call1', function: { name: 'run', arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '42}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const raw = events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
  const response = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(raw.slice(0, 23)); yield Buffer.from(raw.slice(23)); } } };
  const result = await adaptOpenAIResponse(response, { model: 'm', stream: true });
  assert.match(await result.text(), /"stop_reason":"tool_use"/);
  assert.match(await result.text(), /partial_json/);
});

test('token count is explicit zero without tokenizer', () => assert.equal(approximateTokenCount({}).input_tokens, 0));

test('OpenAI SSE is emitted incrementally before upstream completion', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const response = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('data: '+JSON.stringify({ id: 'x', choices: [{ delta: { content: 'first' } }] })+'\n\n');
      await barrier;
      yield Buffer.from('data: '+JSON.stringify({ choices: [{ delta: { content: 'second' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
    },
  } };
  const converted = await adaptOpenAIResponse(response, { model: 'm', stream: true });
  const iterator = converted.body[Symbol.asyncIterator]();
  assert.match((await iterator.next()).value.toString(), /message_start/);
  assert.match((await iterator.next()).value.toString(), /content_block_start/);
  assert.match((await iterator.next()).value.toString(), /first/);
  release();
  let tail = '';
  for await (const bytes of { [Symbol.asyncIterator]: () => iterator }) tail += bytes.toString();
  assert.match(tail, /second/);
  assert.match(tail, /message_stop/);
});

test('malformed streamed tool JSON fails instead of reporting a successful tool', async () => {
  const raw = 'data: '+JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'run', arguments: '{bad' } }] }, finish_reason: 'tool_calls' }] })+'\n\ndata: [DONE]\n\n';
  const response = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } } };
  const converted = await adaptOpenAIResponse(response, { model: 'm', stream: true });
  await assert.rejects(async () => { for await (const _ of converted.body) {} }, /malformed tool arguments/);
});


test('invalid OpenAI streamed tool input includes bounded recovery metadata', async () => {
  const raw = 'data: '+JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'Write', arguments: '{bad' } }] }, finish_reason: 'tool_calls' }] })+'\n\ndata: [DONE]\n\n';
  const response = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } } };
  const converted = await adaptOpenAIResponse(response, { model: 'm', stream: true });
  await assert.rejects(async () => { for await (const _ of converted.body) {} }, (err) => {
    assert.equal(err.code, 'vllm_invalid_tool_json');
    assert.deepEqual(err.details, { tool_name: 'Write', partial_json_bytes: 4 });
    return true;
  });
});

test('OpenAI tool input must be a JSON object', () => {
  assert.throws(() => toAnthropicMessage({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'Write', arguments: '[1]' } }] } }] }), /malformed tool arguments/);
});


test('V0.29.59 fails closed when finish_reason arrives but DONE is missing for tool call', async () => {
  const raw = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'Bash', arguments: '{"command":"echo safe"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\n';
  const upstream = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } } };
  const adapted = await adaptOpenAIResponse(upstream, { model: 'm', stream: true });
  let output = '';
  await assert.rejects(async () => { for await (const part of adapted.body) output += part.toString(); }, err => {
    assert.equal(err.code, 'vllm_invalid_tool_json');
    assert.equal(err.details.tool_name, 'Bash');
    return true;
  });
  assert.doesNotMatch(output, /event: content_block_stop/);
  assert.doesNotMatch(output, /event: message_stop/);
});

test('V0.29.59 interrupted partial tool JSON never emits completed tool block', async () => {
  const raw = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call2', function: { name: 'Write', arguments: '{"file_path":' } }] } }] }) + '\n\n';
  const upstream = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } } };
  const adapted = await adaptOpenAIResponse(upstream, { model: 'm', stream: true });
  let output = '';
  await assert.rejects(async () => { for await (const part of adapted.body) output += part.toString(); }, err => {
    assert.equal(err.code, 'vllm_invalid_tool_json');
    assert.equal(err.details.partial_json_bytes, Buffer.byteLength('{"file_path":'));
    return true;
  });
  assert.doesNotMatch(output, /event: content_block_stop/);
});

test('V0.29.59 interrupted text-only stream is not misclassified as malformed tool JSON', async () => {
  const raw = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }) + '\n\n';
  const upstream = { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } } };
  const adapted = await adaptOpenAIResponse(upstream, { model: 'm', stream: true });
  await assert.rejects(async () => { for await (const _ of adapted.body) {} }, err => err.code === 'vllm_invalid_stream');
});
