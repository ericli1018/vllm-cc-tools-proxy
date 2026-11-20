import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';
import { RuntimeClockRegistry, RUNTIME_CONTEXT_MARKER } from '../src/proxy/runtime-clock.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function read(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw; }
function markerEntries(body) {
  const out = [];
  for (let index = 0; index < (body.messages || []).length; index += 1) {
    const content = body.messages[index]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block?.type === 'text' && String(block.text || '').startsWith(RUNTIME_CONTEXT_MARKER)) {
      out.push({ index, text: block.text });
    }
  }
  return out;
}
function user(text) { return { role: 'user', content: [{ type: 'text', text }] }; }
function toolUse(id) { return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'true' } }] }; }
function toolResult(id) { return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }; }
function assistant(text) { return { role: 'assistant', content: [{ type: 'text', text }] }; }

async function setup(t) {
  const seen = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    const raw = await read(req); const body = raw ? JSON.parse(raw) : {};
    seen.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/count_tokens')) return res.end(JSON.stringify({ input_tokens: 12 }));
    return res.end(JSON.stringify({
      id: `m${seen.length}`, type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 1 },
    }));
  }));
  let nowMs = Date.parse('2026-11-20T16:40:12Z');
  const runtimeClockRegistry = new RuntimeClockRegistry({ clock: () => nowMs });
  const cfg = {
    ...loadConfig({
      VLLM_BASE_URL: `${upstream}/v1`, VLLM_BASE_API_PROTOCOL: 'anthropic', VLLM_BASE_MODEL: 'physical',
      PROXY_RUNTIME_TIME_ENABLED: 'true', PROXY_RUNTIME_TIMEZONE: 'Asia/Taipei',
      COMPLETION_PROBE_ENABLED: 'false', MEDIA_HISTORY_NORMALIZATION_ENABLED: 'false', LOG_LEVEL: 'error',
    }),
    usagePreflightEnabled: false,
  };
  const proxy = await listen(t, createProxyServer(cfg, { runtimeClockRegistry }));
  const headers = { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-1' };
  const post = (path, body) => fetch(`${proxy}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { seen, post, setNow: (iso) => { nowMs = Date.parse(iso); } };
}

const T1 = '[VCC_CONTEXT_META_V1 local_time=2026-11-21T00:40:12+08:00 timezone=Asia/Taipei]';
const T2 = '[VCC_CONTEXT_META_V1 local_time=2026-11-21T00:48:31+08:00 timezone=Asia/Taipei]';

test('V0.29.82 count_tokens and inference reuse the exact same timestamp for one visible user turn', async (t) => {
  const f = await setup(t);
  const body = { model: 'claude-opus-5-5', max_tokens: 32, stream: false, messages: [user('hello')] };
  let r = await f.post('/v1/messages/count_tokens', { ...body, max_tokens: undefined }); assert.equal(r.status, 200); await r.text();
  f.setNow('2026-11-20T16:41:12Z');
  r = await f.post('/v1/messages', body); assert.equal(r.status, 200); await r.text();
  assert.deepEqual(markerEntries(f.seen[0].body), [{ index: 0, text: T1 }]);
  assert.deepEqual(markerEntries(f.seen[1].body), [{ index: 0, text: T1 }]);
});

test('V0.29.82 external tool_result continuation restores T1 at the original user turn and does not create T2', async (t) => {
  const f = await setup(t);
  let r = await f.post('/v1/messages', { model: 'm', max_tokens: 32, messages: [user('run it')] }); assert.equal(r.status, 200); await r.text();
  f.setNow('2026-11-20T16:45:00Z');
  r = await f.post('/v1/messages', { model: 'm', max_tokens: 32, messages: [user('run it'), toolUse('t1'), toolResult('t1')] }); assert.equal(r.status, 200); await r.text();
  assert.deepEqual(markerEntries(f.seen[0].body), [{ index: 0, text: T1 }]);
  assert.deepEqual(markerEntries(f.seen[1].body), [{ index: 0, text: T1 }]);
});

test('V0.29.82 a later visible user turn restores old T1 and gets one new T2 at the new tail', async (t) => {
  const f = await setup(t);
  let r = await f.post('/v1/messages', { model: 'm', max_tokens: 32, messages: [user('first')] }); assert.equal(r.status, 200); await r.text();
  f.setNow('2026-11-20T16:48:31Z');
  r = await f.post('/v1/messages', { model: 'm', max_tokens: 32, messages: [user('first'), assistant('done'), user('second')] }); assert.equal(r.status, 200); await r.text();
  assert.deepEqual(markerEntries(f.seen[1].body), [
    { index: 0, text: T1 },
    { index: 2, text: T2 },
  ]);
});

test('V0.29.82 managed ToolSearch rounds keep the same interaction timestamp', async (t) => {
  const bodies = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    const raw = await read(req); const body = raw ? JSON.parse(raw) : {};
    bodies.push(body);
    res.setHeader('content-type', 'application/json');
    if (bodies.length === 1) {
      return res.end(JSON.stringify({
        id: 'search-1', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'search-use', name: 'tool_search_tool_bm25', input: { query: 'github issue', limit: 1 } }],
        stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 3 },
      }));
    }
    return res.end(JSON.stringify({
      id: 'done-2', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 1 },
    }));
  }));
  let nowMs = Date.parse('2026-11-20T16:40:12Z');
  const runtimeClockRegistry = new RuntimeClockRegistry({ clock: () => nowMs });
  const cfg = {
    ...loadConfig({
      VLLM_BASE_URL: `${upstream}/v1`, VLLM_BASE_API_PROTOCOL: 'anthropic', VLLM_BASE_MODEL: 'physical',
      PROXY_RUNTIME_TIME_ENABLED: 'true', PROXY_RUNTIME_TIMEZONE: 'Asia/Taipei',
      COMPLETION_PROBE_ENABLED: 'false', MEDIA_HISTORY_NORMALIZATION_ENABLED: 'false', LOG_LEVEL: 'error',
    }),
    usagePreflightEnabled: false,
  };
  const proxy = await listen(t, createProxyServer(cfg, { runtimeClockRegistry }));
  const response = await fetch(`${proxy}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-managed' },
    body: JSON.stringify({
      model: 'm', max_tokens: 64, stream: false,
      tools: [
        { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
        { name: 'mcp__github__search_issues', description: 'Search GitHub issues', defer_loading: true,
          input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      ],
      messages: [user('find issue')],
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(bodies.length, 2);
  assert.deepEqual(markerEntries(bodies[0]), [{ index: 0, text: T1 }]);
  assert.deepEqual(markerEntries(bodies[1]), [{ index: 0, text: T1 }]);
});
