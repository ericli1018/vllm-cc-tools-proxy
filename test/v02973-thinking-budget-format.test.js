import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { resolveModelRoute } from '../src/proxy/model-router.js';
import { toOpenAIRequest } from '../src/services/openai-upstream-adapter.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const request = (model = 'alias', stream = false) => ({
  model, messages: [{ role: 'user', content: `Return OK ${model}` }],
  max_tokens: 2048, stream,
  output_config: { effort: 'xhigh' },
  thinking: { type: 'enabled', budget_tokens: 1200 },
});
const response = { id: 'budget-response', choices: [{ finish_reason: 'stop', message: { reasoning_content: 'checking', content: 'OK' } }] };
const route = (url, extra = {}) => ({ url: `${url}/v1`, protocol: 'openai', model: 'served-model', ...extra });
const base = { VLLM_BASE_URL: 'http://127.0.0.1:1/v1', VLLM_BASE_API_PROTOCOL: 'openai', VLLM_BASE_MODEL: 'fallback',
  COMPLETION_PROBE_ENABLED: 'false', MODEL_RESPONSE_LANGUAGE: 'en-US', LOG_LEVEL: 'error' };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
async function serve(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// RED: the v0.29.72 adapter always emits thinking_token_budget when enabled.
test('v0.29.73 selects none, vllm or tensorfold thinking budget without touching max_tokens and effort', () => {
  const input = request();
  for (const [format, expectedKey] of [['none', null], ['vllm', 'thinking_token_budget'], ['tensorfold', 'thinking_budget']]) {
    const body = toOpenAIRequest(input, { mapThinkingBudget: true, thinkingBudgetFormat: format });
    assert.equal(body.reasoning_effort, 'xhigh');
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.thinking_token_budget, expectedKey === 'thinking_token_budget' ? 1200 : undefined);
    assert.equal(body.thinking_budget, expectedKey === 'thinking_budget' ? 1200 : undefined);
  }
  // Preserve existing adapter call sites when no explicit format is supplied.
  assert.equal(toOpenAIRequest(input, { mapThinkingBudget: true }).thinking_token_budget, 1200);
  assert.equal(toOpenAIRequest(input).thinking_budget, undefined);
});

test('v0.29.73 validates per-route formats and keeps legacy boolean configuration', () => {
  const config = loadConfig({ ...base, VLLM_OPENAI_THINKING_BUDGET_ENABLED: 'true', VLLM_MODEL_ROUTES: JSON.stringify({
    legacy_on: route('http://localhost:4000', { thinking_budget_enabled: true }),
    legacy_off: route('http://localhost:4000', { thinking_budget_enabled: false }),
    tensorfold: route('http://localhost:4000', { thinking_budget_format: 'tensorfold' }),
    none: route('http://localhost:4000', { thinking_budget_format: 'none', thinking_budget_enabled: true }),
    vllm: route('http://localhost:4000', { thinking_budget_format: 'vllm', thinking_budget_enabled: false }),
    inherit: route('http://localhost:4000'),
  }) });
  assert.equal(resolveModelRoute('tensorfold', config).thinkingBudgetFormat, 'tensorfold');
  assert.equal(resolveModelRoute('none', config).thinkingBudgetFormat, 'none');
  assert.equal(resolveModelRoute('vllm', config).thinkingBudgetFormat, 'vllm');
  assert.equal(resolveModelRoute('legacy_on', config).thinkingBudgetEnabled, true);
  assert.equal(resolveModelRoute('legacy_off', config).thinkingBudgetEnabled, false);
  assert.equal(resolveModelRoute('inherit', config).thinkingBudgetFormat, undefined);
  for (const invalid of [null, false, true, 10, 'auto', 'thinking_budget', 'VLLM']) {
    assert.throws(() => loadConfig({ ...base, VLLM_MODEL_ROUTES: JSON.stringify({ alias: route('http://localhost:4000', { thinking_budget_format: invalid }) }) }), /thinking_budget_format/);
  }
});

test('v0.29.73 disables manual budget when thinking is disabled, with all formats', () => {
  const input = { ...request(), thinking: { type: 'disabled', budget_tokens: 1200 } };
  for (const format of ['vllm', 'tensorfold', 'none']) {
    const out = toOpenAIRequest(input, { thinkingBudgetFormat: format });
    assert.equal(out.reasoning_effort, 'none');
    assert.equal(out.thinking_token_budget, undefined);
    assert.equal(out.thinking_budget, undefined);
  }
  assert.throws(() => toOpenAIRequest({ ...request(), thinking: { type: 'enabled', budget_tokens: -12 } }, { thinkingBudgetFormat: 'tensorfold' }), /Invalid thinking budget/);
});

test('v0.29.73 real proxy HTTP sends isolated budget formats for streaming and JSON with legacy fallback', async t => {
  const observed = [];
  const backend = await serve(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const payload = JSON.parse(raw);
    observed.push({ path: req.url, payload });
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 's1', choices: [{ delta: { reasoning_content: 'step' } }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  });
  const aliases = {
    tf: route(backend.url, { thinking_budget_format: 'tensorfold' }),
    vl: route(backend.url, { thinking_budget_format: 'vllm' }),
    none: route(backend.url, { thinking_budget_format: 'none' }),
    old: route(backend.url, { thinking_budget_enabled: true }),
    inherit: route(backend.url),
  };
  const config = loadConfig({ ...base, VLLM_OPENAI_THINKING_BUDGET_ENABLED: 'false', VLLM_MODEL_ROUTES: JSON.stringify(aliases) });
  const proxy = await serve(createProxyServer(config).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const cases = [['tf', true, 'thinking_budget'], ['vl', false, 'thinking_token_budget'], ['none', true, null], ['old', false, 'thinking_token_budget'], ['inherit', false, null]];
  const results = await Promise.all(cases.map(async ([alias, stream]) => {
    const res = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request(alias, stream)) });
    const text = await res.text();
    return { alias, status: res.status, text, contentType: res.headers.get('content-type') };
  }));
  for (const item of results) {
    assert.equal(item.status, 200, `${item.alias}: ${item.text.slice(0, 150)}`);
    assert.match(item.text, /OK/);
  }
  assert.equal(observed.length, cases.length);
  for (const [alias, stream, expectedKey] of cases) {
    const req = observed.find(x => x.payload.model === 'served-model' && x.payload.stream === stream && (
      // Headers are not used for model aliases; instead identify by request's unique user text below.
      x.payload.messages.some(m => JSON.stringify(m.content).includes(`Return OK ${alias}`))
    ));
    // This should always pick the request for its alias and prevent cross-request state leakage.
    assert.ok(req, `Missing request from alias ${alias}`);
    assert.equal(req.path, '/v1/chat/completions');
    assert.equal(req.payload.reasoning_effort, 'xhigh');
    assert.equal(req.payload.thinking_budget, expectedKey === 'thinking_budget' ? 1200 : undefined);
    assert.equal(req.payload.thinking_token_budget, expectedKey === 'thinking_token_budget' ? 1200 : undefined);
  }
});

test('v0.29.73 Anthropic route ignores vendor format and forwards native thinking unchanged', async t => {
  let observed;
  const backend = await serve(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    observed = { path: req.url, body: JSON.parse(raw) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', id: 'native', model: 'native-model',
      content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 2 } }));
  });
  const config = loadConfig({ ...base, VLLM_MODEL_ROUTES: JSON.stringify({
    native: { url: `${backend.url}/v1`, protocol: 'anthropic', model: 'native-model', thinking_budget_format: 'tensorfold' },
  }) });
  const proxy = await serve(createProxyServer(config).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const res = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request('native')) });
  assert.equal(res.status, 200, await res.text());
  assert.equal(observed.path, '/v1/messages');
  assert.equal(observed.body.thinking.budget_tokens, 1200);
  assert.equal(observed.body.thinking_budget, undefined);
  assert.equal(observed.body.thinking_token_budget, undefined);
  assert.equal(observed.body.output_config.effort, 'xhigh');
});
