import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const CLIENT_KEY = 'test-client-key-should-never-reach-upstream';
const BACKEND_KEY = 'test-backend-key';
const env = (extra = {}) => ({ VLLM_BASE_URL: 'http://127.0.0.1:9', ...extra });
const input = (stream = false, managed = false) => ({
  model: 'client-alias', stream, max_tokens: 128,
  messages: [{ role: 'user', content: 'Please reply hello.' }],
  ...(managed ? { tools: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }] } : {}),
});

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { protocol = 'anthropic', key = BACKEND_KEY, extra = {} } = {}) {
  const seen = [], logs = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    let body; try { body = JSON.parse(text); } catch { body = null; }
    seen.push({ url: req.url, method: req.method, headers: req.headers, body, text });
    if (req.url.startsWith('/v1/models')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ object: 'list', data: [] }));
    }
    if (req.url.endsWith('/count_tokens')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ input_tokens: 12 }));
    }
    if (protocol === 'openai') {
      if (body?.stream) {
        res.setHeader('content-type', 'text/event-stream');
        return res.end(`data: ${JSON.stringify({ id: 'test-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ id: 'test-chat', choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2 } }));
    }
    const message = { id: 'test-msg', type: 'message', role: 'assistant', model: 'upstream-model', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 2 } };
    if (body?.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      return res.end(sse('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
        + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })
        + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
        + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
        + sse('message_stop', { type: 'message_stop' }));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(message));
  }));
  const config = {
    ...loadConfig(env({ VLLM_BASE_URL: upstream, VLLM_BASE_API_PROTOCOL: protocol, VLLM_BASE_API_KEY: key,
      PROXY_AUTH_ENABLED: 'true', PROXY_API_KEY: CLIENT_KEY, COMPLETION_PROBE_ENABLED: 'false',
      PROXY_RUNTIME_TIME_ENABLED: 'false', ...(typeof extra === 'function' ? extra(upstream) : extra) })),
    cache: { rootDir: '', maxBytes: 0 }, usagePreflightEnabled: false,
    logSink: entry => logs.push(entry),
  };
  const proxy = await listen(t, createProxyServer(config));
  const post = (body = input(), headers = {}, path = '/v1/messages') => fetch(proxy + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { proxy, upstream, seen, logs, config, post };
}

function rawRequest(url, { method = 'POST', path = '/v1/messages', headers = {}, body = '{}', incomplete = false } = {}) {
  return new Promise((resolve, reject) => {
    const wireHeaders = Array.isArray(headers) ? ['Host', new URL(url).host, ...headers] : headers;
    const req = http.request(url + path, { method, headers: wireHeaders }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, text }); });
    });
    req.setTimeout(2000, () => req.destroy(new Error('auth did not reject before request body')));
    req.on('error', reject);
    if (incomplete) req.flushHeaders(); else req.end(body);
  });
}

test('V0.29.75 config: no credentials preserves disabled compatibility mode', () => {
  const c = loadConfig(env()); assert.equal(c.proxyAuthEnabled, false); assert.equal(c.proxyApiKey, '');
});
test('V0.29.75 config: key alone enables auth and explicit false overrides it', () => {
  assert.equal(loadConfig(env({ PROXY_API_KEY: CLIENT_KEY })).proxyAuthEnabled, true);
  assert.equal(loadConfig(env({ PROXY_API_KEY: CLIENT_KEY, PROXY_AUTH_ENABLED: 'false' })).proxyAuthEnabled, false);
});
test('V0.29.75 config: explicit true without key fails closed', () => {
  for (const key of ['', ' ', '\t']) assert.throws(() => loadConfig(env({ PROXY_AUTH_ENABLED: 'true', PROXY_API_KEY: key })), /PROXY_API_KEY/);
});
test('V0.29.75 config: invalid boolean and unsafe key rejected without echoing secrets', () => {
  assert.throws(() => loadConfig(env({ PROXY_AUTH_ENABLED: 'ture', PROXY_API_KEY: CLIENT_KEY })), /PROXY_AUTH_ENABLED/);
  for (const key of [' '+CLIENT_KEY, CLIENT_KEY+' ', 'bad\nkey', 'bad,key', '秘密', 'a'.repeat(513)]) {
    assert.throws(() => loadConfig(env({ PROXY_API_KEY: key })), error => /PROXY_API_KEY/.test(error.message) && !error.message.includes(key));
  }
});
test('V0.29.75 HTTP: unauthenticated protected endpoints fail before body processing or forwarding', async t => {
  const f = await fixture(t);
  for (const path of ['/v1/messages', '/api/messages', '/v1/messages/count_tokens', '/api/messages/count_tokens', '/v1/chat/completions', '/v1/responses', '/v1/models', '/cc-tool-proxy/status/session', '/api/hello', '/health/extra', '/health/']) {
    const r = await f.post('not JSON', {}, path);
    assert.equal(r.status, 401, path);
    assert.match(r.headers.get('www-authenticate'), /Bearer/);
    const body = await r.json(); assert.equal(body.error.type, 'authentication_error');
    assert.doesNotMatch(JSON.stringify(body), new RegExp(CLIENT_KEY));
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) {
    const r = await fetch(f.proxy+'/v1/models', { method }); assert.equal(r.status, 401, method); await r.text();
  }
  assert.equal(f.seen.length, 0);
  assert.equal(f.logs.some(x => /managed_request_started|claude_agent_request_observed/.test(x.event)), false);
});
test('V0.29.75 HTTP: a missing key is rejected without waiting for an incomplete large body', async t => {
  const f = await fixture(t);
  const r = await rawRequest(f.proxy, { headers: { 'content-length': '1000000' }, incomplete: true });
  assert.equal(r.status, 401); assert.equal(r.headers.connection, 'close'); assert.equal(f.seen.length, 0);
});
test('V0.29.75 HTTP: malformed, conflicting, duplicate and query credentials are rejected', async t => {
  const f = await fixture(t);
  for (const headers of [
    { authorization: 'Bearer wrong' }, { 'x-api-key': 'wrong' }, { authorization: 'Basic '+CLIENT_KEY },
    { authorization: 'Bearer' }, { authorization: 'Bearer '+CLIENT_KEY+',wrong' },
    { authorization: 'Bearer '+CLIENT_KEY, 'x-api-key': 'wrong' },
    { authorization: 'Basic wrong', 'x-api-key': CLIENT_KEY },
  ]) { const r = await f.post(input(), headers); assert.equal(r.status, 401); await r.text(); }
  for (const headers of [
    ['Authorization','Bearer '+CLIENT_KEY,'authorization','Bearer '+CLIENT_KEY],
    ['X-Api-Key',CLIENT_KEY,'x-api-key',CLIENT_KEY],
    ['Authorization','Bearer wrong','authorization','Bearer '+CLIENT_KEY],
  ]) assert.equal((await rawRequest(f.proxy, { headers })).status, 401);
  const r = await f.post(input(), {}, '/v1/messages?api_key='+CLIENT_KEY); assert.equal(r.status, 401); await r.text();
  assert.equal(f.seen.length, 0);
  const logged = JSON.stringify(f.logs); assert.ok(!logged.includes(CLIENT_KEY)); assert.ok(!logged.includes('Bearer wrong'));
});
test('V0.29.75 HTTP: GET health endpoints remain public and do not reveal configured keys', async t => {
  const f = await fixture(t);
  for (const path of ['/health', '/healthz', '/health?probe=1']) {
    const r = await fetch(f.proxy+path); assert.equal(r.status, 200);
    const s = await r.text(); assert.ok(!s.includes(CLIENT_KEY)); assert.ok(!s.includes(BACKEND_KEY));
  }
  const r = await f.post(input(), {}, '/health'); assert.equal(r.status, 401); await r.text();
  assert.equal(f.seen.length, 0);
});

for (const protocol of ['anthropic','openai']) for (const stream of [false,true]) for (const managed of [false,true]) {
  test(`V0.29.75 HTTP: ${protocol} stream=${stream} managed=${managed} accepts credentials and isolates upstream`, async t => {
    const f = await fixture(t, { protocol });
    const r = await f.post(input(stream, managed), { authorization: 'bEaReR '+CLIENT_KEY, 'x-api-key': CLIENT_KEY, 'anthropic-version': '2023-06-01' });
    assert.equal(r.status, 200); const text = await r.text(); assert.match(text, /hello/);
    if (stream) assert.match(text, /event: message_stop/);
    assert.ok(f.seen.length > 0);
    for (const call of f.seen) {
      assert.equal(call.headers.authorization, 'Bearer '+BACKEND_KEY);
      if (protocol === 'anthropic') assert.equal(call.headers['x-api-key'], BACKEND_KEY);
      assert.ok(!JSON.stringify(call.headers).includes(CLIENT_KEY));
    }
  });
}
for (const protocol of ['anthropic','openai']) {
  test(`V0.29.75 HTTP: ${protocol} without backend key never forwards client credentials`, async t => {
    const f = await fixture(t, { protocol, key: '' });
    const r = await f.post(input(false,true), { 'x-api-key': CLIENT_KEY }); assert.equal(r.status, 200); await r.text();
    assert.ok(f.seen.length > 0);
    for (const c of f.seen) { assert.equal(c.headers.authorization, undefined); assert.equal(c.headers['x-api-key'], undefined); }
  });
}
test('V0.29.75 HTTP: bypass and count_tokens use backend key, never the ingress key', async t => {
  const f = await fixture(t);
  for (const path of ['/v1/messages/count_tokens', '/api/messages/count_tokens', '/v1/chat/completions']) {
    const r = await f.post(input(), { 'x-api-key': CLIENT_KEY }, path); assert.equal(r.status, 200); await r.text();
  }
  const r = await fetch(f.proxy+'/v1/models?list=1', { headers: { authorization: 'Bearer '+CLIENT_KEY } });
  assert.equal(r.status, 200); await r.text();
  assert.ok(f.seen.length >= 4);
  for (const c of f.seen) { assert.equal(c.headers.authorization, 'Bearer '+BACKEND_KEY); assert.equal(c.headers['x-api-key'], BACKEND_KEY); }
});
test('V0.29.75 HTTP: invalid-JSON bypass without backend key strips both frontend headers', async t => {
  const f = await fixture(t, { key: '' });
  const r = await f.post('invalid JSON', { authorization: 'Bearer '+CLIENT_KEY, 'x-api-key': CLIENT_KEY });
  assert.equal(r.status, 200); await r.text();
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].headers.authorization, undefined); assert.equal(f.seen[0].headers['x-api-key'], undefined);
});
test('V0.29.75 HTTP: status requires auth; valid key reaches local status handler', async t => {
  const f = await fixture(t);
  const r = await fetch(f.proxy+'/cc-tool-proxy/status/missing', { headers: { 'x-api-key': CLIENT_KEY } });
  assert.equal(r.status, 404); assert.equal((await r.json()).status, 'unknown_session'); assert.equal(f.seen.length, 0);
});
test('V0.29.75 HTTP: disabled auth warns once and preserves old forwarding', async t => {
  const f = await fixture(t, { key: '', extra: { PROXY_AUTH_ENABLED: 'false' } });
  const r = await f.post(input(), { 'x-api-key': 'legacy-backend-key' }); assert.equal(r.status, 200); await r.text();
  const r2 = await f.post(input()); assert.equal(r2.status, 200); await r2.text();
  assert.equal(f.seen[0].headers['x-api-key'], 'legacy-backend-key');
  assert.equal(f.logs.filter(e => e.event === 'proxy_auth_disabled').length, 1);
  assert.ok(!JSON.stringify(f.logs).includes(CLIENT_KEY));
});

test('V0.29.75 HTTP: concurrent routed requests use route keys or no key rather than base/client key', async t => {
  const f = await fixture(t, { extra: url => ({ VLLM_MODEL_ROUTES: JSON.stringify({
    keyed: { url, protocol: 'anthropic', model: 'route-keyed', api_key: 'route-only-key' },
    keyless: { url, protocol: 'anthropic', model: 'route-keyless' },
  }) }) });
  await Promise.all(['keyed','keyless'].map(async model => {
    const r = await f.post({ ...input(false,true), model }, { authorization: 'Bearer '+CLIENT_KEY, 'x-api-key': CLIENT_KEY });
    assert.equal(r.status, 200); await r.text();
  }));
  assert.equal(f.seen.length, 2);
  for (const c of f.seen) {
    const expected = c.body.model === 'route-keyed' ? 'route-only-key' : undefined;
    assert.equal(c.headers.authorization, expected ? 'Bearer '+expected : undefined);
    assert.equal(c.headers['x-api-key'], expected);
    assert.ok(!JSON.stringify(c.headers).includes(CLIENT_KEY));
  }
});
