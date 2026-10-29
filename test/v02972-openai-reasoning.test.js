import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { toOpenAIRequest, toAnthropicMessage, adaptOpenAIResponse } from '../src/services/openai-upstream-adapter.js';
import { loadConfig } from '../src/config.js';
import { resolveModelRoute } from '../src/proxy/model-router.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const baseRequest = (extra = {}) => ({ model: 'm', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8192, stream: false, ...extra });
const wrapSse = raw => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: { async *[Symbol.asyncIterator]() { for (let pos = 0; pos < raw.length; pos += 19) yield Buffer.from(raw.slice(pos, pos + 19)); } } });
const sse = (item) => `data: ${JSON.stringify(item)}\n\n`;
const parseEvents = raw => raw.split(/\r?\n\r?\n/).filter(Boolean).map(frame => {
  const name = frame.match(/^event:\s*(.*)$/m)?.[1];
  const line = frame.match(/^data:\s*(.*)$/m)?.[1];
  return { name, data: line ? JSON.parse(line) : {} };
});
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
async function serve(handler) { const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return { server, url: `http://127.0.0.1:${server.address().port}` }; }

// RED: output_config.effort was silently discarded in v0.29.71.
test('V0.29.72 translates all Claude effort levels without rewriting xhigh or max', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const body = toOpenAIRequest(baseRequest({ output_config: { effort } }));
    assert.equal(body.reasoning_effort, effort);
    assert.equal(body.max_tokens, 8192);
  }
  assert.equal(toOpenAIRequest(baseRequest()).reasoning_effort, undefined);
  assert.throws(() => toOpenAIRequest(baseRequest({ output_config: { effort: 'insane' } })), /effort/i);
});

test('V0.29.72 respects disabled and enabled thinking without destroying explicit effort', () => {
  assert.equal(toOpenAIRequest(baseRequest({ thinking: { type: 'disabled' }, output_config: { effort: 'high' } })).reasoning_effort, 'none');
  const enabled = toOpenAIRequest(baseRequest({ thinking: { type: 'enabled', budget_tokens: 15000 } }));
  assert.equal(enabled.chat_template_kwargs?.enable_thinking, true);
  assert.equal(enabled.reasoning_effort, undefined);
  const adaptive = toOpenAIRequest(baseRequest({ thinking: { type: 'adaptive' } }));
  assert.equal(adaptive.chat_template_kwargs, undefined);
});

test('V0.29.72 opt-in maps manual budget to vLLM thinking_token_budget, never max_tokens', () => {
  const request = baseRequest({ thinking: { type: 'enabled', budget_tokens: 16000 }, output_config: { effort: 'xhigh' } });
  assert.equal(toOpenAIRequest(request).thinking_token_budget, undefined);
  const mapped = toOpenAIRequest(request, { mapThinkingBudget: true });
  assert.equal(mapped.reasoning_effort, 'xhigh');
  assert.equal(mapped.thinking_token_budget, 16000);
  assert.equal(mapped.max_tokens, 8192);
  const disabled = toOpenAIRequest(baseRequest({ thinking: { type: 'disabled', budget_tokens: 700 } }), { mapThinkingBudget: true });
  assert.equal(disabled.thinking_token_budget, undefined);
  assert.equal(disabled.reasoning_effort, 'none');
});

test('V0.29.72 validates global opt-in and route-level overrides', () => {
  const env = { VLLM_BASE_URL: 'http://fallback:8000/v1', VLLM_OPENAI_THINKING_BUDGET_ENABLED: 'true', VLLM_MODEL_ROUTES: JSON.stringify({
    'a': { url: 'http://a:8000/v1', protocol: 'openai', model: 'a', thinking_budget_enabled: false },
    'b': { url: 'http://b:8000/v1', protocol: 'openai', model: 'b', thinking_budget_enabled: true },
  }) };
  const config = loadConfig(env);
  assert.equal(config.vllmOpenaiThinkingBudgetEnabled, true);
  assert.equal(resolveModelRoute('a', config).thinkingBudgetEnabled, false);
  assert.equal(resolveModelRoute('b', config).thinkingBudgetEnabled, true);
  assert.equal(loadConfig({ VLLM_BASE_URL: 'http://fallback:8000/v1' }).vllmOpenaiThinkingBudgetEnabled, false);
  assert.throws(() => loadConfig({ ...env, VLLM_OPENAI_THINKING_BUDGET_ENABLED: 'yes' }), /VLLM_OPENAI_THINKING_BUDGET_ENABLED/);
  assert.throws(() => loadConfig({ ...env, VLLM_MODEL_ROUTES: JSON.stringify({ a: { url: 'http://a', protocol: 'openai', model: 'm', thinking_budget_enabled: 'true' } }) }), /thinking_budget_enabled/);
});

test('V0.29.72 converts OpenAI reasoning or legacy reasoning_content to thinking before text and tools', () => {
  for (const field of ['reasoning', 'reasoning_content']) {
    const message = toAnthropicMessage({ id: 'r', choices: [{ finish_reason: 'tool_calls', message: {
      [field]: 'analysis', content: 'answer', tool_calls: [{ id: 'call1', function: { name: 'Read', arguments: '{"file_path":"README.md"}' } }],
    } }], usage: { prompt_tokens: 12, completion_tokens: 40 } });
    assert.deepEqual(message.content.map(block => block.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(message.content[0], { type: 'thinking', thinking: 'analysis', signature: '' });
    assert.equal(message.content[1].text, 'answer');
    assert.deepEqual(message.content[2].input, { file_path: 'README.md' });
    assert.equal(message.usage.output_tokens, 40);
  }
  const both = toAnthropicMessage({ choices: [{ finish_reason: 'stop', message: { reasoning: 'new', reasoning_content: 'old', content: 'ok' } }] });
  assert.equal(both.content[0].thinking, 'new');
});

test('V0.29.72 streams reasoning_content and reasoning as thinking_delta before text_delta', async () => {
  const raw = [
    { id: 'stream-reason', choices: [{ delta: { reasoning_content: 'step1 ' } }] },
    { choices: [{ delta: { reasoning: 'step2' } }] },
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
  ].map(sse).join('') + 'data: [DONE]\n\n';
  const converted = await adaptOpenAIResponse(wrapSse(raw), { stream: true, model: 'm' });
  const events = parseEvents(await converted.text());
  assert.deepEqual(events.filter(e => e.name === 'content_block_start').map(e => e.data.content_block.type), ['thinking', 'text']);
  assert.deepEqual(events.filter(e => e.name === 'content_block_delta').map(e => e.data.delta.type), ['thinking_delta','thinking_delta','text_delta']);
  assert.equal(events.filter(e => e.name === 'content_block_delta').map(e => e.data.delta.thinking || e.data.delta.text).join(''), 'step1 step2done');
  assert.equal(events.find(e => e.name === 'message_delta').data.delta.stop_reason, 'end_turn');
});

test('V0.29.72 streaming reasoning interleaves safely with tool calls', async () => {
  const raw = [
    { id: 'stream-tool', choices: [{ delta: { reasoning: 'need tool' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'Read', arguments: '{"file_path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
  ].map(sse).join('') + 'data: [DONE]\n\n';
  const converted = await adaptOpenAIResponse(wrapSse(raw), { stream: true, model: 'm' });
  const events = parseEvents(await converted.text());
  assert.deepEqual(events.filter(e => e.name === 'content_block_start').map(e => e.data.content_block.type), ['thinking', 'tool_use']);
  assert.ok(events.some(e => e.name === 'content_block_stop' && e.data.index === 0));
  assert.ok(events.some(e => e.name === 'content_block_stop' && e.data.index === 1));
  assert.equal(events.find(e => e.name === 'message_delta').data.delta.stop_reason, 'tool_use');
});

test('V0.29.72 non-SSE OpenAI payload in streaming request includes thinking block', async () => {
  const response = { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({
    id: 'json-fallback', choices: [{ finish_reason: 'stop', message: { reasoning: 'work', content: 'result' } }],
  }) };
  const adapted = await adaptOpenAIResponse(response, { stream: true, model: 'm' });
  const events = parseEvents(await adapted.text());
  assert.deepEqual(events.filter(e => e.name === 'content_block_start').map(e => e.data.content_block.type), ['thinking', 'text']);
  assert.deepEqual(events.filter(e => e.name === 'content_block_delta').map(e => e.data.delta.type), ['thinking_delta','text_delta']);
});

test('V0.29.72 HTTP: route-selected OpenAI API receives client effort and opt-in budget', async t => {
  let observed;
  const backend = await serve(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    observed = JSON.parse(raw);
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'r1', model: 'actual', choices: [{ finish_reason: 'stop', message: { reasoning: 'tested', content: 'success' } }] }));
  });
  const config = loadConfig({
    VLLM_BASE_URL: 'http://127.0.0.1:1/v1', VLLM_BASE_MODEL: 'fallback', VLLM_OPENAI_THINKING_BUDGET_ENABLED: 'false',
    VLLM_MODEL_ROUTES: JSON.stringify({ 'client-alias': { url: `${backend.url}/v1`, protocol: 'openai', model: 'actual', thinking_budget_enabled: true } }),
    MODEL_RESPONSE_LANGUAGE: 'en-US', COMPLETION_PROBE_ENABLED: 'false', LOG_LEVEL: 'error',
  });
  const proxy = await serve(createProxyServer(config).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseRequest({
    model: 'client-alias', output_config: { effort: 'xhigh' }, thinking: { type: 'enabled', budget_tokens: 13000 },
  })) });
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const result = await response.json();
  assert.equal(observed.model, 'actual');
  assert.equal(observed.reasoning_effort, 'xhigh');
  assert.equal(observed.thinking_token_budget, 13000);
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'tested');
  assert.equal(result.content[1].text, 'success');
});

test('V0.29.72 decoder and existing Anthropic collector preserve streamed reasoning + tool result', async () => {
  const { collectAnthropicMessageFromSse } = await import('../src/proxy/anthropic-sse-collector.js');
  const upstream = wrapSse([
    { id: 'reason-tools', choices: [{ delta: { reasoning: 'read the file' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call77', function: { name: 'Read', arguments: '{"file_path":"a.js"}' } }] }, finish_reason: 'tool_calls' }] },
  ].map(sse).join('') + 'data: [DONE]\n\n');
  const converted = await adaptOpenAIResponse(upstream, { stream: true, model: 'm' });
  const collected = await collectAnthropicMessageFromSse(converted);
  assert.equal(collected.stop_reason, 'tool_use');
  assert.deepEqual(collected.content.map(item => item.type), ['thinking', 'tool_use']);
  assert.equal(collected.content[0].thinking, 'read the file');
  assert.deepEqual(collected.content[1].input, { file_path: 'a.js' });
});

test('V0.29.72 explicit disabled mode takes precedence over recovery effort and blocks budget', () => {
  const input = baseRequest({
    thinking: { type: 'enabled', budget_tokens: 3000 }, output_config: { effort: 'xhigh' },
    chat_template_kwargs: { enable_thinking: false },
  });
  const result = toOpenAIRequest(input, { mapThinkingBudget: true });
  assert.equal(result.reasoning_effort, 'none');
  assert.equal(result.thinking_token_budget, undefined);
  assert.equal(result.chat_template_kwargs, undefined);
  assert.throws(() => toOpenAIRequest(baseRequest({ thinking: { type: 'enabled', budget_tokens: -1 } }), { mapThinkingBudget: true }), /budget/);
});

test('V0.29.72 HTTP streaming maps output_config.effort and reasoning without changing tool protocol', async t => {
  let observed;
  const backend = await serve(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    observed = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ id: 'stream-http', choices: [{ delta: { reasoning: 'thinking...' } }] }));
    res.end(sse({ choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const config = loadConfig({ VLLM_BASE_URL: `${backend.url}/v1`, VLLM_BASE_API_PROTOCOL: 'openai', VLLM_BASE_MODEL: 'actual',
    MODEL_RESPONSE_LANGUAGE: 'en-US', COMPLETION_PROBE_ENABLED: 'false', LOG_LEVEL: 'error', });
  const proxy = await serve(createProxyServer(config).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseRequest({ stream: true, output_config: { effort: 'medium' } })) });
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.equal(observed.reasoning_effort, 'medium');
  assert.equal(observed.thinking_token_budget, undefined);
  assert.match(raw, /"type":"thinking_delta"/);
  assert.match(raw, /"type":"text_delta"/);
  assert.match(raw, /event: message_stop/);
});

test('V0.29.72 does not emit nested thinking after an uncommitted streaming tool call', async () => {
  const raw = [
    { id: 'tool-then-thinking', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'Read', arguments: '{"file_path":"a.js"}' } }] } }] },
    { choices: [{ delta: { reasoning: 'more work' }, finish_reason: 'tool_calls' }] },
  ].map(sse).join('') + 'data: [DONE]\n\n';
  const converted = await adaptOpenAIResponse(wrapSse(raw), { stream: true, model: 'm' });
  let output = '';
  await assert.rejects(async () => { for await (const part of converted.body) output += part.toString(); }, error => error.code === 'vllm_invalid_stream');
  assert.doesNotMatch(output, /event: message_stop/);
});
