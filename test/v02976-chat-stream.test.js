import test from 'node:test';
import assert from 'node:assert/strict';
import { readSseFrames, relayOpenAIStream } from '../src/services/chat-stream.js';
import { fromAnthropicResponse, fromAnthropicStream, toAnthropicRequest } from '../src/services/openai-client-adapter.js';
async function* pieces(text, width = 1) { const b = Buffer.from(text); for (let i = 0; i < b.length; i += width) yield b.subarray(i, i + width); }
const gather = async iterable => { const out = []; for await (const v of iterable) out.push(v); return out; };
const evt = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const options = { limitBytes: 100000, includeUsage: true };
const base = { model: 'a', messages: [{ role: 'user', content: 'hi' }] };

test('V0.29.76 SSE framing: byte-split UTF8, CRLF, multiline data, comments', async () => {
  const input = ':alive\r\n\r\nevent: test\r\ndata: {"text":\r\ndata: "繁體中文"}\r\n\r\n';
  const result = await gather(readSseFrames(pieces(input), 1000));
  assert.equal(result.length, 2); assert.equal(result[0].hasData, false); assert.equal(JSON.parse(result[1].data).text, '繁體中文');
});
test('V0.29.76 SSE framing rejects oversized, malformed UTF8 and unterminated frames', async () => {
  await assert.rejects(gather(readSseFrames(pieces('data: ' + 'x'.repeat(30)), 20)), /limit/);
  async function* invalid() { yield Buffer.from([0xff]); }
  await assert.rejects(gather(readSseFrames(invalid(), 100)), /UTF-8/);
  await assert.rejects(gather(readSseFrames(pieces('data: {}\n'), 100)), /inside/);
});
test('V0.29.76 native split stream preserves Unicode and vendor payloads', async () => {
  const wire = `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: '中文' }, finish_reason: 'stop' }], vendor: 1 })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const output = (await gather(relayOpenAIStream(pieces(wire), 'alias', { limitBytes: 10000 }))).join('');
  assert.match(output, /中文/); assert.match(output, /"vendor":1/); assert.match(output, /"model":"alias"/); assert.match(output, /\[DONE\]/);
});
test('V0.29.76 reverse input: default output budget and explicit no-thinking', () => {
  const out = toAnthropicRequest({ ...base, reasoning_effort: 'none' }, 'actual');
  assert.equal(out.max_tokens, 4096); assert.equal(out.model, 'actual'); assert.deepEqual(out.thinking, { type: 'disabled' });
});
for (const extra of [{ max_tokens: 1, max_completion_tokens: 2 }, { temperature: 1.5 }, { tools: [{ type: 'function', function: { name: 'x', strict: true } }] }, { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '[' } }] }] }, { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }]) test(`V0.29.76 reverse rejects lossy conversion ${JSON.stringify(extra)}`, () => {
  assert.throws(() => toAnthropicRequest({ ...base, ...extra }, 'actual'), e => e.status === 400 && !!e.details.param);
});
for (const reason of ['end_turn', 'stop_sequence', 'max_tokens', 'refusal']) test(`V0.29.76 JSON finish mapping ${reason}`, () => {
  const out = fromAnthropicResponse({ type: 'message', id: 'x', content: [{ type: 'text', text: 'answer' }], stop_reason: reason, usage: { input_tokens: 5, output_tokens: 2 } }, 'a');
  assert.equal(out.choices[0].finish_reason, { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'content_filter' }[reason]);
});
test('V0.29.76 reverse rejects unsupported stops and response blocks', () => {
  assert.throws(() => fromAnthropicResponse({ type: 'message', id: 'x', content: [], stop_reason: 'pause_turn' }, 'a'), /stop reason/);
  assert.throws(() => fromAnthropicResponse({ type: 'message', id: 'x', content: [{ type: 'server_tool_use' }], stop_reason: 'end_turn' }, 'a'), /content block/);
});
test('V0.29.76 reverse response rejects missing message ID', () => {
  assert.throws(() => fromAnthropicResponse({ type: 'message', content: [], stop_reason: 'end_turn' }, 'a'), e => e.status === 502);
});
test('V0.29.76 reverse stream rejects non-string content_block_start text with 502', async () => {
  const stream = evt('message_start', { message: { id: 'x', type: 'message', content: [] } }) + evt('content_block_start', { index: 0, content_block: { type: 'text', text: 42 } });
  await assert.rejects(gather(fromAnthropicStream(pieces(stream), 'a', options)), e => e.status === 502);
});

test('V0.29.76 reverse JSON: missing usage is not reported as zero token usage', () => {
  const out = fromAnthropicResponse({ type: 'message', id: 'x', content: [], stop_reason: 'end_turn', usage: {} }, 'a');
  assert.equal(out.usage, undefined);
});
test('V0.29.76 reverse SSE: missing usage remains null in requested final usage chunk', async () => {
  const stream = evt('message_start', { message: { id: 'x', type: 'message', content: [] } }) + evt('message_delta', { delta: { stop_reason: 'end_turn' } }) + evt('message_stop', {});
  const out = await gather(fromAnthropicStream(pieces(stream), 'a', options));
  const trailer = out.map(x => x.startsWith('data: {') ? JSON.parse(x.slice(6)) : null).filter(Boolean).at(-1);
  assert.equal(trailer.usage, null);
});
test('V0.29.76 reverse SSE: message ID must be a string', async () => {
  const stream = evt('message_start', { message: { id: 123, type: 'message', content: [] } }) + evt('message_delta', { delta: { stop_reason: 'end_turn' } }) + evt('message_stop', {});
  await assert.rejects(gather(fromAnthropicStream(pieces(stream), 'a', options)), e => e.status === 502);
});
