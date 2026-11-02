import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, { handler, env = {}, routePaths = ['/v1', '/v1'], extraConfig = {} } = {}) {
  const seen = { base: [], a: [], b: [], logs: [] };
  const urls = {};
  for (const [label, count] of [['base', 7], ['a', 211], ['b', 433]]) {
    urls[label] = await listen(t, http.createServer(async (req, res) => {
      let raw = ''; for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      const call = { path: req.url, body, headers: req.headers }; seen[label].push(call);
      if (handler && await handler({ label, count, call, req, res, seen })) return;
      if (req.url.endsWith('/tokenize')) return json(res, { count, max_model_len: 200000, tokens: [10, 20], token_strs: ['a', 'b'] });
      if (req.url.endsWith('/count_tokens')) return json(res, { input_tokens: count });
      if (req.url.endsWith('/chat/completions')) {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ id: 'c', model: body.model, choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: count, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
        } else json(res, { id: 'c', model: body.model, choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: count, completion_tokens: 1 } });
        return;
      }
      return json(res, { error: { message: 'not found' } }, 404);
    }));
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token77-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { ...loadConfig({ VLLM_BASE_URL: urls.base + '/v1', VLLM_BASE_API_PROTOCOL: 'openai', VLLM_BASE_MODEL: 'base-real', VLLM_BASE_API_KEY: 'base-secret',
    VLLM_MODEL_ROUTES: JSON.stringify({ alpha: { url: urls.a + routePaths[0], protocol: 'openai', model: 'a-real', api_key: 'a-secret', thinking_budget_format: 'tensorfold' }, beta: { url: urls.b + routePaths[1], protocol: 'openai', model: 'b-real', api_key: 'b-secret' } }),
    COMPLETION_PROBE_ENABLED: 'false', LANG_PROCESSOR_ENABLED: 'false', PROXY_RUNTIME_REMINDER_ENABLED: 'false', LOG_LEVEL: 'info', ...env }),
    runtimeClockEnabled: false, usagePreflightEnabled: false, logSink: e => seen.logs.push(e),
    cache: { rootDir: root, maxBytes: 0, retentionMs: 60000, pipelineVersion: 'media-v8', visualPromptVersion: 'visual-v18', evidenceContractVersion: 'evidence-v14' }, ...extraConfig };
  const proxy = createProxyServer(config);
  const url = await listen(t, proxy);
  const post = (body = {}, endpoint = '/v1/messages/count_tokens', headers = { 'x-api-key': 'client-secret' }, signal) => fetch(url + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'alpha', messages: [{ role: 'user', content: '你好' }], ...body }), signal });
  return { seen, config, post, url };
}
for (const suffix of ['', '/v1', '/v1/', '/v1/chat/completions', '/gateway/v1/messages']) {
  test(`V0.29.77 routed OpenAI count queries tokenizer for base suffix ${suffix}`, async t => {
    const { post, seen } = await setup(t, { routePaths: [suffix, '/v1'] });
    const r = await post(); const result = await r.json();
    assert.equal(r.status, 200); assert.equal(result.input_tokens, 211);
    assert.equal(seen.base.length, 0); assert.equal(seen.b.length, 0); assert.equal(seen.a.length, 1);
    assert.equal(seen.a[0].path, suffix.startsWith('/gateway') ? '/gateway/tokenize' : '/tokenize');
    assert.equal(seen.a[0].body.model, 'a-real'); assert.equal(seen.a[0].headers.authorization, 'Bearer a-secret');
    assert.equal(seen.a[0].headers['x-api-key'], undefined);
  });
}
test('V0.29.77 counting retains converted system, tools, tool results and thinking, never generation fields', async t => {
  const { post, seen } = await setup(t);
  const r = await post({ system: 'keep-policy', stream: true, max_tokens: 8192, temperature: 0.7,
    thinking: { type: 'enabled', budget_tokens: 4096 }, output_config: { effort: 'high' },
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'pwd' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '/work' }] }] });
  assert.equal(r.status, 200, await r.text());
  assert.equal(seen.a.length, 1);
  const body = seen.a[0].body;
  assert.match(body.messages[0].content, /keep-policy/);
  assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"command":"pwd"}');
  assert.equal(body.messages[3].tool_call_id, 'tool1'); assert.equal(body.messages[3].content, '/work');
  assert.equal(body.tools[0].function.name, 'Bash'); assert.equal(body.tool_choice, 'auto');
  assert.equal(body.reasoning_effort, 'high'); assert.equal(body.thinking_budget, 4096);
  assert.equal(body.add_generation_prompt, true);
  for (const name of ['stream', 'stream_options', 'max_tokens', 'temperature']) assert.equal(body[name], undefined);
});
test('V0.29.77 simultaneous counts keep URL, key and model isolated per alias', async t => {
  const { post, seen } = await setup(t, { handler: async ({ label }) => { if (label === 'a') await new Promise(resolve => setTimeout(resolve, 30)); return false; } });
  const results = await Promise.all(['alpha', 'beta', 'alpha', 'beta'].map(async model => (await post({ model })).json()));
  assert.deepEqual(results.map(v => v.input_tokens), [211, 433, 211, 433]);
  assert.equal(seen.base.length, 0);
  for (const label of ['a', 'b']) for (const call of seen[label]) {
    assert.equal(call.body.model, `${label}-real`); assert.equal(call.headers.authorization, `Bearer ${label}-secret`);
  }
});
for (const mode of ['reject', 'fallback']) test(`V0.29.77 count unknown alias ${mode}`, async t => {
  const { post, seen } = await setup(t, { env: { VLLM_MODEL_ROUTING_UNKNOWN_MODEL: mode } });
  const r = await post({ model: 'unknown' }); const b = await r.json();
  assert.equal(r.status, mode === 'reject' ? 400 : 200);
  if (mode === 'fallback') { assert.equal(b.input_tokens, 7); assert.equal(seen.base[0].body.model, 'base-real'); assert.equal(seen.base[0].headers.authorization, 'Bearer base-secret'); }
  assert.equal(seen.a.length + seen.b.length, 0);
});
test('V0.29.77 OpenAI Base without router uses its own tokenizer', async t => {
  const { post, seen } = await setup(t, { env: { VLLM_MODEL_ROUTING_ENABLED: 'false' } });
  assert.equal((await (await post()).json()).input_tokens, 7); assert.equal(seen.a.length, 0); assert.equal(seen.base[0].path, '/tokenize');
});
for (const endpoint of ['/tokenize', '/v1/tokenize', '/v1/tokenize/']) test(`V0.29.77 direct ${endpoint} follows router preserving native request and token IDs`, async t => {
  const { post, seen } = await setup(t);
  const r = await post({ model: 'beta', messages: undefined, prompt: 'hello', add_special_tokens: true, return_token_strs: true }, endpoint);
  assert.equal(r.status, 200); const b = await r.json(); assert.equal(b.count, 433); assert.deepEqual(b.tokens, [10, 20]); assert.deepEqual(b.token_strs, ['a', 'b']);
  assert.equal(seen.base.length, 0); assert.equal(seen.a.length, 0); assert.equal(seen.b[0].path, '/tokenize');
  assert.deepEqual(seen.b[0].body, { model: 'b-real', prompt: 'hello', add_special_tokens: true, return_token_strs: true });
});
for (const target of ['/v1/tokenize', '/v1/messages/count_tokens']) test(`V0.29.77 unsupported endpoint fallback stays on route: ${target}`, async t => {
  const { post, seen } = await setup(t, { handler: async ({ call, count, res }) => {
    if (call.path === target) { json(res, target.endsWith('count_tokens') ? { input_tokens: count } : { count }); return true; }
    json(res, { error: { message: 'not found' } }, 404); return true;
  } });
  const r = await post({ thinking: { type: 'enabled', budget_tokens: 1024 }, system: 'policy' });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json())); assert.equal((await r.json()).input_tokens, 211);
  assert.equal(seen.base.length, 0); assert.equal(seen.a.at(-1).path, target);
  if (target.endsWith('count_tokens')) { assert.equal(seen.a.at(-1).body.system, 'policy'); assert.equal(seen.a.at(-1).body.thinking.budget_tokens, 1024); assert.equal(seen.a.at(-1).headers['x-api-key'], 'a-secret'); }
});
for (const status of [400, 401, 403, 429, 500, 302]) test(`V0.29.77 tokenizer HTTP ${status} must not fallback or leak upstream content`, async t => {
  const { post, seen } = await setup(t, { handler: async ({ res }) => { res.setHeader('location', 'http://127.0.0.1:1/steal'); json(res, { error: { message: 'a-secret client-secret sensitive-prompt' } }, status); return true; } });
  const r = await post(); const wire = await r.text();
  assert.equal(r.status, status === 302 ? 502 : status); assert.doesNotMatch(wire, /a-secret|client-secret|sensitive-prompt/);
  assert.equal(seen.a.length, 1); assert.equal(seen.base.length, 0);
});
for (const value of [null, -1, 1.5, '123', true, 9007199254740992]) test(`V0.29.77 invalid count ${JSON.stringify(value)} cannot become a zero success`, async t => {
  const { post, seen } = await setup(t, { handler: async ({ res }) => { json(res, { count: value }); return true; } });
  const r = await post(); assert.equal(r.status, 502, await r.text()); assert.equal(seen.a.length, 1);
});
test('V0.29.77 backend confirmed zero is allowed; missing count or empty body is not', async t => {
  let mode = 0;
  const { post } = await setup(t, { handler: async ({ res }) => { if (mode === 0) json(res, { count: 0 }); else if (mode === 1) json(res, {}); else res.end(); return true; } });
  assert.equal((await (await post()).json()).input_tokens, 0);
  mode = 1; assert.equal((await post()).status, 502);
  mode = 2; assert.equal((await post()).status, 502);
});
test('V0.29.77 all counting endpoints unsupported yields explicit 501, never generation', async t => {
  const { post, seen } = await setup(t, { handler: async ({ res }) => { json(res, {}, 404); return true; } });
  const r = await post(); const b = await r.json(); assert.equal(r.status, 501); assert.equal(b.error.type, 'token_count_unsupported');
  assert.deepEqual(seen.a.map(c => c.path), ['/tokenize', '/v1/tokenize', '/v1/messages/count_tokens']); assert.equal(seen.base.length, 0);
});
for (const stream of [true, false]) test(`V0.29.77 Managed uses pinned count for SSE and inference usage for JSON stream=${stream}`, async t => {
  const { post, seen } = await setup(t, { extraConfig: { usagePreflightEnabled: true } });
  const r = await post({ max_tokens: 64, stream, tools: [{ name: 'WebSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }] }, '/v1/messages');
  assert.equal(r.status, 200); const text = await r.text(); assert.match(text, /完成/);
  assert.equal(seen.a.some(c => c.path === '/tokenize'), stream); assert.ok(seen.a.some(c => c.path === '/v1/chat/completions')); assert.equal(seen.base.length, 0);
  assert.equal(seen.logs.some(e => e.event === 'managed_usage_preflight_succeeded' && e.input_tokens === 211), stream);
  assert.ok(seen.a.every(c => c.body.model === 'a-real' && c.headers.authorization === 'Bearer a-secret'));
});
test('V0.29.77 tokenizer endpoints enforce ingress auth before touching any backend', async t => {
  const { post, seen } = await setup(t, { env: { PROXY_AUTH_ENABLED: 'true', PROXY_API_KEY: 'ingress-key' } });
  for (const endpoint of ['/tokenize', '/v1/tokenize', '/v1/messages/count_tokens']) {
    assert.equal((await post({}, endpoint)).status, 401);
    assert.equal((await post({}, endpoint, { authorization: 'Bearer ingress-key' })).status, 200);
  }
  assert.equal(seen.a.length, 3); assert.ok(seen.a.every(c => c.headers.authorization === 'Bearer a-secret' && c.headers['x-api-key'] !== 'ingress-key'));
});
test('V0.29.77 no configured route key never forwards ingress key', async t => {
  const { post, seen, config } = await setup(t);
  config.modelRouting = { ...config.modelRouting, routes: { alpha: { ...config.modelRouting.routes.alpha, apiKey: '' } } };
  assert.equal((await post()).status, 200); assert.equal(seen.a[0].headers.authorization, undefined); assert.equal(seen.a[0].headers['x-api-key'], undefined);
});

test('V0.29.77 explicit backend model-not-found 404 is not capability fallback', async t => {
  const { post, seen } = await setup(t, { handler: async ({ res }) => { json(res, { error: { code: 'model_not_found' } }, 404); return true; } });
  assert.equal((await post()).status, 404); assert.equal(seen.a.length, 1); assert.equal(seen.base.length, 0);
});
test('V0.29.77 tokenizer header timeout is not retried on another endpoint', async t => {
  const { post, seen } = await setup(t, { handler: async () => true,
    extraConfig: { vllmBaseTimeouts: { connectTimeoutMs: 1000, headersTimeoutMs: 50, bodyTimeoutMs: 50 } } });
  const r = await post(); assert.equal(r.status, 504); assert.equal((await r.json()).error.type, 'vllm_headers_timeout'); assert.equal(seen.a.length, 1);
});
test('V0.29.77 client cancellation aborts the backend tokenizer connection', { timeout: 5000 }, async t => {
  let arrived, closed;
  const arrival = new Promise(resolve => { arrived = resolve; }); const closure = new Promise(resolve => { closed = resolve; });
  const { post, seen } = await setup(t, { handler: async ({ res }) => { res.once('close', closed); arrived(); return true; } });
  const controller = new AbortController();
  const pending = post({}, '/v1/messages/count_tokens', {}, controller.signal);
  const rejected = assert.rejects(pending, err => err.name === 'AbortError');
  await arrival; controller.abort(); await rejected; await closure;
  assert.equal(seen.a.length, 1); assert.equal(seen.base.length, 0);
});
test('V0.29.77 oversized tokenizer JSON is bounded and returns 502', async t => {
  const { post, seen, config } = await setup(t, { handler: async ({ res }) => { json(res, { count: 211, tokens: Array(2000).fill(12345) }); return true; } });
  config.limits = { ...config.limits, maxRequestBytes: 1024 };
  const r = await post(); assert.equal(r.status, 502); assert.equal(seen.a.length, 1);
});
test('V0.29.77 failed Managed preflight logs failure and does not claim a successful zero count', async t => {
  const { post, seen } = await setup(t, { handler: async ({ call, res }) => { if (call.path.endsWith('/tokenize')) { json(res, {}, 500); return true; } return false; }, extraConfig: { usagePreflightEnabled: true } });
  const r = await post({ stream: true, max_tokens: 32, tools: [{ name: 'WebSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }] }, '/v1/messages');
  assert.equal(r.status, 200); assert.match(await r.text(), /完成/);
  assert.ok(seen.logs.some(e => e.event === 'managed_usage_preflight_failed'));
  assert.ok(!seen.logs.some(e => e.event === 'managed_usage_preflight_succeeded'));
  assert.equal(seen.a.filter(c => c.path.endsWith('tokenize')).length, 1);
});
test('V0.29.77 direct tokenizer rejects invalid JSON without using Base', async t => {
  const { url, seen } = await setup(t);
  for (const body of ['{oops', 'null', '[]']) {
    const r = await fetch(url + '/tokenize', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 400);
  }
  assert.equal(seen.base.length + seen.a.length + seen.b.length, 0);
});
test('V0.29.77 direct tokenizer unknown alias follows reject policy', async t => {
  const { post, seen } = await setup(t);
  assert.equal((await post({ model: 'missing', prompt: 'x' }, '/tokenize')).status, 400);
  assert.equal(seen.base.length + seen.a.length + seen.b.length, 0);
});
test('V0.29.77 token-count diagnostics retain request correlation without credentials or content', async t => {
  const { post, seen } = await setup(t);
  await (await post()).text();
  const entries = seen.logs.filter(e => ['token_count_upstream_request', 'token_count_succeeded'].includes(e.event));
  assert.equal(entries.length, 2);
  assert.ok(entries.every(e => typeof e.requestId === 'string' && e.requestId.length > 0));
  assert.equal(entries[0].requestId, entries[1].requestId);
  assert.doesNotMatch(JSON.stringify(entries), /a-secret|client-secret|你好/);
});
