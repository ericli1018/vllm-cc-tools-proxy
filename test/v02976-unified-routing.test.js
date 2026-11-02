import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const KEY = 'client-only-secret';
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chat = (model = 'alpha', extra = {}) => ({ model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, ...extra });
const message = (model = 'upstream', extra = {}) => ({ id: 'msg_test', type: 'message', role: 'assistant', model,
  content: [{ type: 'text', text: 'upstream says 中文' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }, ...extra });
function anthroSse(msg = message()) {
  let text = event('message_start', { message: { ...msg, content: [], stop_reason: null } });
  msg.content.forEach((block, index) => {
    text += event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: block.type, [block.type === 'text' ? 'text' : 'thinking']: '' } });
    text += event('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: `${block.type}_delta`, [block.type === 'text' ? 'text' : 'thinking']: block.text ?? block.thinking } });
    text += event('content_block_stop', { index });
  });
  return text + event('message_delta', { delta: { stop_reason: msg.stop_reason }, usage: { output_tokens: msg.usage.output_tokens } }) + event('message_stop', {});
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function backend(t, protocol = 'openai', handler) {
  const seen = [];
  const url = await listen(t, http.createServer(async (req, res) => {
    try {
      let text = ''; for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : null;
      const entry = { body, url: req.url, headers: req.headers }; seen.push(entry);
      if (handler) return await handler(req, res, entry);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ object: 'list', data: [{ id: 'backend-model' }] }));
      if (req.url.endsWith('/count_tokens')) return res.end('{"input_tokens":10}');
      if (protocol === 'anthropic') {
        const msg = message(body?.model);
        if (body?.stream) { res.setHeader('content-type', 'text/event-stream'); return res.end(anthroSse(msg)); }
        return res.end(JSON.stringify(msg));
      }
      const result = { id: 'chat_test', object: 'chat.completion', created: 1, model: body?.model, choices: [{ index: 0, message: { role: 'assistant', content: 'upstream says 中文' }, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } };
      if (body?.stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(frame({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'upstream says 中文' }, finish_reason: null }], usage: null }));
        return res.end(frame({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + frame('[DONE]'));
      }
      res.end(JSON.stringify(result));
    } catch { if (!res.destroyed) res.destroy(); }
  }));
  return { url, seen };
}
async function proxy(t, base, routes, extra = {}) {
  const logs = [];
  const config = { ...loadConfig({ VLLM_BASE_URL: base.url, VLLM_BASE_API_PROTOCOL: 'openai', VLLM_BASE_MODEL: 'base-real',
    VLLM_BASE_API_KEY: 'base-key', PROXY_AUTH_ENABLED: 'true', PROXY_API_KEY: KEY, PROXY_RUNTIME_TIME_ENABLED: 'false', COMPLETION_PROBE_ENABLED: 'false',
    ...(routes ? { VLLM_MODEL_ROUTES: JSON.stringify(routes) } : {}), ...extra }), cache: { rootDir: '', maxBytes: 0 }, usagePreflightEnabled: false,
    logSink: x => logs.push(x) };
  const url = await listen(t, createProxyServer(config));
  const send = (body = chat(), path = '/v1/chat/completions', headers = {}) => fetch(url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  return { url, logs, send };
}
const route = (b, protocol = 'openai', model = 'route-real', key = 'route-key') => ({ url: b.url, protocol, model, api_key: key });
const chunks = text => text.split(/\r?\n\r?\n/).map(x => x.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(x => x && x !== '[DONE]').map(x => JSON.parse(x));

test('V0.29.76 models: aliases are local, distinct, authenticated and contain no backend secrets', async t => {
  const b = await backend(t); const p = await proxy(t, b, { alpha: route(b), beta: route(b) }, { VLLM_MODEL_ROUTING_UNKNOWN_MODEL: 'fallback' });
  assert.equal((await fetch(p.url + '/v1/models')).status, 401);
  const r = await fetch(p.url + '/v1/models', { headers: { 'x-api-key': KEY } });
  const body = await r.json(); assert.equal(r.status, 200); assert.equal(body.object, 'list');
  assert.deepEqual(body.data.map(x => x.id), ['alpha', 'beta']);
  for (const m of body.data) { assert.equal(m.object, 'model'); assert.equal(typeof m.created, 'number'); }
  assert.doesNotMatch(JSON.stringify(body), /route-real|route-key|127\.0\.0\.1|base-real/); assert.equal(b.seen.length, 0);
});
test('V0.29.76 models: disabled router still queries base catalog', async t => {
  const b = await backend(t); const p = await proxy(t, b, { alpha: route(b) }, { VLLM_MODEL_ROUTING_ENABLED: 'false' });
  const r = await fetch(p.url + '/v1/models', { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal((await r.json()).data[0].id, 'backend-model'); assert.equal(b.seen.length, 1);
});
for (const stream of [false, true]) test(`V0.29.76 native router stream=${stream}: chosen URL/model/key and client alias`, async t => {
  const b = await backend(t), a = await backend(t); const p = await proxy(t, b, { alpha: route(a) });
  const body = chat('alpha', { stream, seed: 42, reasoning_effort: 'xhigh', thinking_budget: 1024, response_format: { type: 'json_object' }, vendor_option: { keep: true } });
  const r = await p.send(body); assert.equal(r.status, 200);
  const out = stream ? chunks(await r.text()).filter(x => x.choices?.length)[0] : await r.json();
  assert.equal(out.model, 'alpha'); assert.equal(a.seen.length, 1); assert.equal(b.seen.length, 0);
  assert.deepEqual(a.seen[0].body, { ...body, model: 'route-real' });
  assert.equal(a.seen[0].headers.authorization, 'Bearer route-key'); assert.equal(a.seen[0].headers['x-api-key'], undefined);
});
test('V0.29.76 router: unknown alias rejects locally in OpenAI error format', async t => {
  const b = await backend(t), p = await proxy(t, b, { alpha: route(b) }); const r = await p.send(chat('unknown'));
  assert.equal(r.status, 400); const data = await r.json(); assert.equal(data.error.code, 'unknown_model_alias'); assert.equal(data.error.type, 'invalid_request_error'); assert.equal(b.seen.length, 0);
});
test('V0.29.76 router: fallback uses complete base settings, not another alias', async t => {
  const b = await backend(t), a = await backend(t), p = await proxy(t, b, { 'base-real': route(a) }, { VLLM_MODEL_ROUTING_UNKNOWN_MODEL: 'fallback' });
  const r = await p.send(chat('unknown')); assert.equal(r.status, 200); assert.equal((await r.json()).model, 'unknown');
  assert.equal(a.seen.length, 0); assert.equal(b.seen[0].body.model, 'base-real'); assert.equal(b.seen[0].headers.authorization, 'Bearer base-key');
});
test('V0.29.76 router: routing disabled still uses Base protocol for chat', async t => {
  const b = await backend(t, 'anthropic'), p = await proxy(t, b, null, { VLLM_BASE_API_PROTOCOL: 'anthropic' });
  const r = await p.send(); assert.equal(r.status, 200); assert.equal((await r.json()).object, 'chat.completion'); assert.equal(b.seen[0].url, '/v1/messages');
});
for (const suffix of ['', '/', '/v1', '/v1/', '/v1/chat/completions', '/v1/chat/completions/', '/v1/messages/']) test(`V0.29.76 URL normalization ${suffix || 'host'}`, async t => {
  const b = await backend(t), p = await proxy(t, b, { alpha: { ...route(b), url: b.url + suffix } });
  const r = await p.send(chat(), '/v1/chat/completions/?trace=1'); await r.text(); assert.equal(r.status, 200); assert.equal(b.seen[0].url, '/v1/chat/completions?trace=1');
});
for (const stream of [false, true]) test(`V0.29.76 reverse bridge stream=${stream}: text, leading instructions, effort and usage`, async t => {
  const b = await backend(t), a = await backend(t, 'anthropic'), p = await proxy(t, b, { alpha: route(a, 'anthropic') });
  const r = await p.send(chat('alpha', { stream, max_tokens: undefined, max_completion_tokens: 128, reasoning_effort: 'high', stream_options: stream ? { include_usage: true } : undefined,
    messages: [{ role: 'system', content: 'A' }, { role: 'developer', content: [{ type: 'text', text: 'B' }] }, { role: 'user', content: 'hello' }] }));
  const out = stream ? chunks(await r.text()) : await r.json(); assert.equal(r.status, 200);
  assert.equal(a.seen[0].url, '/v1/messages'); assert.equal(a.seen[0].body.system, 'A\n\nB'); assert.equal(a.seen[0].body.max_tokens, 128);
  assert.equal(a.seen[0].body.output_config.effort, 'high'); assert.deepEqual(a.seen[0].body.thinking, { type: 'adaptive' });
  assert.equal(a.seen[0].headers['x-api-key'], 'route-key'); assert.equal(a.seen[0].headers['anthropic-version'], '2023-06-01'); assert.equal(b.seen.length, 0);
  if (stream) {
    assert.ok(out.every(x => x.object === 'chat.completion.chunk')); assert.ok(out.every(x => x.model === 'alpha'));
    assert.equal(out.map(x => x.choices?.[0]?.delta?.content || '').join(''), 'upstream says 中文');
    assert.equal(out.at(-1).usage.prompt_tokens, 17); assert.equal(out.at(-1).usage.prompt_tokens_details.cached_tokens, 5);
    assert.equal(out.at(-2).choices[0].finish_reason, 'stop');
  } else { assert.equal(out.model, 'alpha'); assert.equal(out.choices[0].message.content, 'upstream says 中文'); assert.equal(out.usage.total_tokens, 20); }
});
test('V0.29.76 reverse bridge: parallel tools and tool-result history, no proxy execution', async t => {
  const b = await backend(t), a = await backend(t, 'anthropic', async (req, res, e) => {
    const isFirst = e.body.messages.length === 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(message(e.body.model, isFirst ? { content: [1,2].map(i => ({ type: 'tool_use', id: `call${i}`, name: 'Write', input: { path: `/not-executed/${i}`, text: 'route-real' } })), stop_reason: 'tool_use' } : {})));
  });
  const p = await proxy(t, b, { alpha: route(a, 'anthropic') }); const tools = [{ type: 'function', function: { name: 'Write', description: 'test', parameters: { type: 'object' } } }];
  const first = await (await p.send(chat('alpha', { tools, tool_choice: 'required', parallel_tool_calls: false }))).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls'); assert.equal(first.choices[0].message.tool_calls.length, 2);
  assert.equal(JSON.parse(first.choices[0].message.tool_calls[0].function.arguments).text, 'route-real');
  assert.deepEqual(a.seen[0].body.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  const history = [chat().messages[0], first.choices[0].message, ...[1,2].map(i => ({ role: 'tool', tool_call_id: `call${i}`, content: 'ok' }))];
  const r = await p.send(chat('alpha', { tools, messages: history })); assert.equal(r.status, 200); await r.text();
  assert.deepEqual(a.seen[1].body.messages.at(-1).content.map(x => x.tool_use_id), ['call1', 'call2']);
});
for (const extra of [{ n: 2 }, { logprobs: true }, { response_format: { type: 'json_schema', json_schema: {} } }, { seed: 3 }, { unknown_vendor_field: true }, { reasoning_effort: 'minimal' }]) test(`V0.29.76 reverse rejects unsupported ${JSON.stringify(extra)}`, async t => {
  const b = await backend(t), a = await backend(t, 'anthropic'), p = await proxy(t, b, { alpha: route(a, 'anthropic') });
  const r = await p.send(chat('alpha', extra)); assert.equal(r.status, 400); const out = await r.json(); assert.equal(out.error.type, 'invalid_request_error'); assert.ok(out.error.param); assert.equal(a.seen.length + b.seen.length, 0);
});
test('V0.29.76 reverse bridge: image URL and base64 preserved without proxy media pipeline', async t => {
  const b = await backend(t), a = await backend(t, 'anthropic'), p = await proxy(t, b, { alpha: route(a, 'anthropic') });
  const r = await p.send(chat('alpha', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] })); await r.text();
  assert.equal(r.status, 200); assert.deepEqual(a.seen[0].body.messages[0].content.map(x => x.source.type), ['url', 'base64']);
  assert.equal(p.logs.some(x => /media_|completion_probe/.test(x.event)), false);
});
test('V0.29.76 auth: missing credentials fail before routing and malformed body parsing', async t => {
  const b = await backend(t), p = await proxy(t, b, { alpha: route(b) });
  const r = await fetch(p.url + '/v1/chat/completions', { method: 'POST', body: '{' });
  assert.equal(r.status, 401); assert.equal((await r.json()).error.code, 'authentication_error'); assert.equal(b.seen.length, 0);
});
test('V0.29.76 native JSON: only top-level model is rewritten, nested text and metadata untouched', async t => {
  const b = await backend(t, 'openai', async (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'route-real', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'route-real', tool_calls: [{ type: 'function', id: 'c', function: { name: 'f', arguments: '{"model":"route-real"}' } }] }, finish_reason: 'tool_calls' }], vendor: { model: 'route-real' } })); });
  const p = await proxy(t, b, { alpha: route(b) }); const out = await (await p.send()).json();
  assert.equal(out.model, 'alpha'); assert.equal(out.vendor.model, 'route-real'); assert.equal(out.choices[0].message.content, 'route-real');
});
test('V0.29.76 concurrent endpoints and mixed protocols share route resolution but isolate keys', async t => {
  const b = await backend(t), a = await backend(t), c = await backend(t, 'anthropic');
  const p = await proxy(t, b, { alpha: route(a, 'openai', 'a-real', 'a-key'), beta: route(c, 'anthropic', 'b-real', 'b-key') });
  const all = await Promise.all(['alpha', 'beta'].flatMap(alias => [p.send(chat(alias)), p.send({ model: alias, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: false }, '/v1/messages')]));
  for (const r of all) { assert.equal(r.status, 200); await r.text(); }
  assert.equal(a.seen.length, 2); assert.equal(c.seen.length, 2); assert.equal(b.seen.length, 0);
  for (const x of a.seen) { assert.equal(x.body.model, 'a-real'); assert.equal(x.headers.authorization, 'Bearer a-key'); }
  for (const x of c.seen) { assert.equal(x.body.model, 'b-real'); assert.equal(x.headers['x-api-key'], 'b-key'); }
});

for (const protocol of ['openai', 'anthropic']) test(`V0.29.76 stream safety ${protocol}: truncated terminal never commits tools`, async t => {
  const b = await backend(t), a = await backend(t, protocol, async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    if (protocol === 'openai') return res.end(frame({ id: 'x', model: 'real', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'Write', arguments: '{"x":1}' } }] }, finish_reason: null }] })
      + frame({ id: 'x', model: 'real', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    res.end(anthroSse(message('real', { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { x: 1 } }], stop_reason: 'tool_use' })).replace(event('message_stop', {}), ''));
  });
  const p = await proxy(t, b, { alpha: route(a, protocol) });
  const r = await p.send(chat('alpha', { stream: true })); const text = await r.text(); const out = chunks(text);
  assert.doesNotMatch(text, /^data: \[DONE\]$/m); assert.ok(out.some(x => x.error?.code === 'invalid_upstream_response'));
  assert.equal(out.some(x => x.choices?.some(c => c.finish_reason != null)), false);
  if (protocol === 'anthropic') assert.equal(out.some(x => x.choices?.[0]?.delta?.tool_calls), false);
});
for (const protocol of ['openai', 'anthropic']) test(`V0.29.76 stream safety ${protocol}: malformed tool JSON is error, not completed action`, async t => {
  const b = await backend(t), a = await backend(t, protocol, async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    if (protocol === 'openai') return res.end(frame({ id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'Write', arguments: '{"x":' } }] }, finish_reason: 'tool_calls' }] }) + frame('[DONE]'));
    const s = anthroSse(message('real', { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { x: 1 } }], stop_reason: 'tool_use' }));
    res.end(s.replace(JSON.stringify('{"x":1}'), JSON.stringify('{"x":')));
  });
  const p = await proxy(t, b, { alpha: route(a, protocol) });
  const text = await (await p.send(chat('alpha', { stream: true }))).text();
  assert.doesNotMatch(text, /^data: \[DONE\]$/m); assert.ok(chunks(text).some(x => x.error?.code === 'invalid_upstream_response'));
});
for (const protocol of ['openai', 'anthropic']) test(`V0.29.76 streaming ${protocol}: text arrives before backend ends`, async t => {
  const gate = Promise.withResolvers(); t.after(() => gate.resolve());
  const b = await backend(t), a = await backend(t, protocol, async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    if (protocol === 'openai') res.write(frame({ id: 'early', choices: [{ index: 0, delta: { content: 'EARLY中文' }, finish_reason: null }] }));
    else res.write(event('message_start', { message: message() })
      .replace('"content":[{"type":"text","text":"upstream says 中文"}]', '"content":[]')
      + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'EARLY中文' } }));
    await gate.promise;
    if (protocol === 'openai') res.end(frame({ id: 'early', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + frame('[DONE]'));
    else res.end(event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn' } }) + event('message_stop', {}));
  });
  const p = await proxy(t, b, { alpha: route(a, protocol) });
  const r = await p.send(chat('alpha', { stream: true })), reader = r.body.getReader(); let early = '';
  for (let i = 0; i < 4 && !early.includes('EARLY中文'); i++) {
    const next = await Promise.race([reader.read(), delay(1500).then(() => ({ timeout: true }))]);
    assert.ok(!next.timeout, 'first text must not wait for upstream completion'); if (next.done) break; early += new TextDecoder().decode(next.value);
  }
  assert.match(early, /EARLY中文/); gate.resolve();
  while (!(await reader.read()).done) { /* drain */ }
});
for (const protocol of ['openai', 'anthropic']) test(`V0.29.76 disconnect ${protocol}: only selected upstream is cancelled`, async t => {
  const closed = Promise.withResolvers(); const b = await backend(t), a = await backend(t, protocol, async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write(protocol === 'openai' ? frame({ id: 'x', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }) : event('message_start', { message: { ...message(), content: [] } }));
    res.once('close', () => closed.resolve(true));
  });
  const p = await proxy(t, b, { alpha: route(a, protocol) }); const controller = new AbortController();
  const r = await fetch(p.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(chat('alpha', { stream: true })), signal: controller.signal });
  await r.body.getReader().read(); controller.abort();
  assert.equal(await Promise.race([closed.promise, delay(1500).then(() => false)]), true); assert.equal(b.seen.length, 0);
});
test('V0.29.76 native: n=2, stream usage and vendor fields are preserved', async t => {
  const b = await backend(t, 'openai', async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    for (let i = 0; i < 2; i++) res.write(frame({ id: 'x', model: 'real', vendor: true, choices: [{ index: i, delta: { content: `text${i}` }, finish_reason: 'stop' }] }));
    res.end(frame({ id: 'x', model: 'real', choices: [], usage: { prompt_tokens: 2, completion_tokens: 6, total_tokens: 8 } }) + frame('[DONE]'));
  });
  const p = await proxy(t, b, { alpha: route(b) }); const r = await p.send(chat('alpha', { n: 2, stream: true, stream_options: { include_usage: true } }));
  const text = await r.text(), out = chunks(text); assert.match(text, /\[DONE\]/);
  assert.equal(out.flatMap(x => x.choices || []).filter(x => x.finish_reason === 'stop').length, 2); assert.equal(out.at(-1).usage.total_tokens, 8); assert.ok(out.some(x => x.vendor));
});
test('V0.29.76 reverse: successful tool SSE emits tool_calls and correct usage only at completion', async t => {
  const b = await backend(t), a = await backend(t, 'anthropic', async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end(anthroSse(message('real', { content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', id: 't1', name: 'Write', input: { text: '中文' } }], stop_reason: 'tool_use' })));
  });
  const p = await proxy(t, b, { alpha: route(a, 'anthropic') }); const text = await (await p.send(chat('alpha', { stream: true, stream_options: { include_usage: true } }))).text();
  const out = chunks(text); assert.match(text, /\[DONE\]/); assert.equal(out.filter(x => x.choices?.[0]?.delta?.tool_calls).length, 1);
  assert.equal(out.find(x => x.choices?.[0]?.delta?.reasoning_content).choices[0].delta.reasoning_content, 'plan');
  assert.equal(JSON.parse(out.find(x => x.choices?.[0]?.delta?.tool_calls).choices[0].delta.tool_calls[0].function.arguments).text, '中文');
  assert.equal(out.at(-2).choices[0].finish_reason, 'tool_calls');
});
for (const protocol of ['openai', 'anthropic']) test(`V0.29.76 ${protocol}: upstream HTTP error retains status/retry-after and never reroutes`, async t => {
  const b = await backend(t), a = await backend(t, protocol, async (req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }); res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Busy', code: 'busy' } })); });
  const p = await proxy(t, b, { alpha: route(a, protocol) }); const r = await p.send();
  assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '3'); assert.equal((await r.json()).error.code, 'busy'); assert.equal(b.seen.length, 0); assert.equal(a.seen.length, 1);
});
test('V0.29.76 keyless route: ignores incoming authorization/cookie even with auth disabled', async t => {
  const b = await backend(t), a = await backend(t), p = await proxy(t, b, { alpha: route(a, 'openai', 'a-real', '') }, { PROXY_AUTH_ENABLED: 'false' });
  const r = await p.send(chat(), '/v1/chat/completions', { 'x-api-key': 'do-not-leak', cookie: 'private' }); await r.text(); assert.equal(r.status, 200);
  for (const key of ['authorization', 'x-api-key', 'cookie', 'proxy-authorization']) assert.equal(a.seen[0].headers[key], undefined);
});
for (const value of ['{', 'null', '[]', JSON.stringify({ model: 'alpha', messages: [] })]) test(`V0.29.76 invalid chat body ${value}`, async t => {
  const b = await backend(t), p = await proxy(t, b, { alpha: route(b) }); const r = await p.send(value); assert.equal(r.status, 400); assert.equal((await r.json()).error.type, 'invalid_request_error'); assert.equal(b.seen.length, 0);
});
test('V0.29.76 reverse: late system instructions and unmatched tool results are not silently rewritten', async t => {
  const b = await backend(t), a = await backend(t, 'anthropic'), p = await proxy(t, b, { alpha: route(a, 'anthropic') });
  for (const messages of [[{ role: 'user', content: 'hi' }, { role: 'system', content: 'late' }], [{ role: 'tool', tool_call_id: 'missing', content: 'bad' }]]) {
    const r = await p.send(chat('alpha', { messages })); assert.equal(r.status, 400); assert.ok((await r.json()).error.param);
  }
  assert.equal(a.seen.length, 0);
});
test('V0.29.76 native SSE error is recorded as failure, without success terminator', async t => {
  const b = await backend(t, 'openai', async (req, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(frame({ error: { message: 'Upstream overloaded', type: 'server_error' } })); });
  const p = await proxy(t, b, { alpha: route(b) }); const text = await (await p.send(chat('alpha', { stream: true }))).text();
  assert.ok(chunks(text).some(x => x.error)); assert.doesNotMatch(text, /^data: \[DONE\]$/m);
  assert.equal(p.logs.some(x => x.event === 'chat_request_completed'), false);
  assert.ok(p.logs.some(x => x.event === 'chat_request_failed'));
});
