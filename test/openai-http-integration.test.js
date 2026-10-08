import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer } from '../src/services/proxy-server.js';

async function serve(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const reqBody = async req => { let s = ''; for await (const chunk of req) s += chunk; return JSON.parse(s); };
const options = url => ({ host: '127.0.0.1', port: 0, vllmBaseUrl: url, vllmBaseApiProtocol: 'openai', vllmBaseModel: 'local-model', vllmBaseApiKey: 'test-key', responseLanguage: 'en-US', logLevel: 'error', usagePreflightEnabled: false, limits: { maxRequestBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxPdfPages: 10, maxOutputChars: 20000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20000000, maxVisualPagesPerBatch: 4 }, concurrency: { visionLimit: 1 } });
const post = (url, body) => fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'chat-test', model: 'local-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

test('V0.29.60 HTTP: Claude Code messages converted to OpenAI streaming SSE and back', async t => {
  const seen = [];
  const backend = await serve(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    seen.push(await reqBody(req));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: 'hello ' }));
    res.end(chunk({ content: 'world' }, 'stop') + 'data: [DONE]\n\n');
  });
  const proxy = await serve(createProxyServer(options(backend.url)).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const response = await post(proxy.url, { model: 'claude-alias', stream: true, max_tokens: 128, messages: [{ role: 'user', content: 'ping' }] });
  const wire = await response.text();
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stream, true);
  assert.equal(seen[0].model, 'local-model');
  assert.match(wire, /hello /);
  assert.match(wire, /world/);
  assert.match(wire, /event: message_stop/);
});

test('V0.29.60 HTTP: interrupted tool-call stream does not acknowledge completion', async t => {
  let invocations = 0;
  const backend = await serve(async (req, res) => {
    await reqBody(req);
    invocations++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo OK"}' } }] }, 'tool_calls'));
  });
  const proxy = await serve(createProxyServer(options(backend.url)).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const response = await post(proxy.url, { model: 'claude-alias', stream: true, max_tokens: 128, messages: [{ role: 'user', content: 'run something' }], tools: [{ name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }] });
  const wire = await response.text();
  assert.ok(invocations >= 1);
  assert.doesNotMatch(wire, /event: message_stop/);
});

test('V0.29.60 HTTP: tool call returned then tool result sent in next Claude Code turn', async t => {
  const seen = [];
  const backend = await serve(async (req, res) => {
    const body = await reqBody(req);
    seen.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (seen.length === 1) {
      res.end(JSON.stringify({ id: 'chat-tool', model: 'local-model', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    } else {
      res.end(JSON.stringify({ id: 'chat-final', model: 'local-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 35, completion_tokens: 5 } }));
    }
  });
  const proxy = await serve(createProxyServer(options(backend.url)).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const first = await post(proxy.url, { model: 'alias', stream: false, max_tokens: 128, messages: [{ role: 'user', content: 'where?' }], tools: [{ name: 'Bash', input_schema: { type: 'object' } }] });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.content[0].type, 'tool_use');
  assert.equal(firstBody.content[0].id, 'call_xyz');
  assert.deepEqual(firstBody.content[0].input, { command: 'pwd' });
  const second = await post(proxy.url, { model: 'alias', stream: false, max_tokens: 128, messages: [
    { role: 'user', content: 'where?' },
    { role: 'assistant', content: firstBody.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_xyz', content: '/srv/project' }] },
  ] });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).content[0].text, 'done');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].messages.at(-1).role, 'tool');
  assert.equal(seen[1].messages.at(-1).tool_call_id, 'call_xyz');
  assert.equal(seen[1].messages.at(-1).content, '/srv/project');
});

test('V0.29.62 HTTP: non-stream OpenAI JSON preserves text, usage, and stop reason', async t => {
  const seen = [];
  const backend = await serve(async (req, res) => {
    seen.push(await reqBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'nonstream-id', model: 'local-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'non-stream works' } }], usage: { prompt_tokens: 19, completion_tokens: 4 } }));
  });
  const proxy = await serve(createProxyServer(options(backend.url)).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const result = await post(proxy.url, { model: 'alias', stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type') || '', /application\/json/);
  const body = await result.json();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stream, false);
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].text, 'non-stream works');
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 19, output_tokens: 4 });
});

test('V0.29.62 HTTP: repeated tool id in separate client requests is not a proxy-managed execution', async t => {
  let upstreamCalls = 0;
  const backend = await serve(async (req, res) => {
    const payload = await reqBody(req);
    upstreamCalls++;
    assert.equal(payload.stream, false);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'same-output', model: 'local-model', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'repeat-id', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] } }], usage: { prompt_tokens: 7, completion_tokens: 6 } }));
  });
  const proxy = await serve(createProxyServer(options(backend.url)).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const input = { model: 'alias', stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'pwd' }], tools: [{ name: 'Bash', input_schema: { type: 'object' } }] };
  const first = await (await post(proxy.url, input)).json();
  const second = await (await post(proxy.url, input)).json();
  assert.equal(upstreamCalls, 2);
  assert.equal(first.content[0].id, 'repeat-id');
  assert.equal(second.content[0].id, 'repeat-id');
  // Client-side Bash is not executed by proxy; cross-request exactly-once is not guaranteed.
});

test('V0.29.65 HTTP: concurrent sessions retain independent non-stream responses', async t => {
  const seen = [];
  const backend = await serve(async (req, res) => {
    const body = await reqBody(req);
    const content = body.messages.at(-1).content.map(x => x.text || "").join("");
    seen.push(content);
    await new Promise(resolve => setTimeout(resolve, content === 'alpha' ? 25 : 5));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: content, model: 'local-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  const proxy = await serve(createProxyServer(options(backend.url)).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const send = (id, msg) => fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': id }, body: JSON.stringify({ model: 'alias', stream: false, max_tokens: 32, messages: [{ role: 'user', content: msg }] }) }).then(r => r.json());
  const [a, b] = await Promise.all([send('session-A', 'alpha'), send('session-B', 'beta')]);
  assert.equal(a.content[0].text, 'alpha');
  assert.equal(b.content[0].text, 'beta');
  assert.deepEqual(seen.sort(), ['alpha', 'beta']);
});

test('V0.29.65 HTTP: independent concurrent streaming sessions complete separately', async t => {
  const backend = await serve(async (req, res) => {
    const body = await reqBody(req);
    const word = body.messages.at(-1).content.map(x => x.text || "").join("");
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: word }));
    await new Promise(resolve => setTimeout(resolve, word === 'left' ? 20 : 5));
    res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  const proxy = await serve(createProxyServer(options(backend.url)).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(backend.server); });
  const send = (id, word) => fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': id }, body: JSON.stringify({ model: 'alias', stream: true, max_tokens: 32, messages: [{ role: 'user', content: word }] }) }).then(r => r.text());
  const [left, right] = await Promise.all([send('stream-A', 'left'), send('stream-B', 'right')]);
  assert.match(left, /left/);
  assert.doesNotMatch(left, /right/);
  assert.match(right, /right/);
  assert.doesNotMatch(right, /left/);
  assert.match(left, /event: message_stop/);
  assert.match(right, /event: message_stop/);
});

test('V0.29.65 HTTP model alias selects correct OpenAI backend with non-stream JSON', async t => {
 const seen = [];
 const backend = await serve(async (req, res) => {
   const body = await reqBody(req);
   seen.push({ path: req.url, model: body.model, authorization: req.headers.authorization });
   res.writeHead(200, { 'content-type': 'application/json' });
   res.end(JSON.stringify({ id: 'route-id', model: 'actual-llm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'selected' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
 });
 const config = options('http://127.0.0.1:1/v1');
 config.modelRouting = { enabled: true, unknownModel: 'reject', routes: { 'requested-alias': { url: backend.url + '/v1', protocol: 'openai', model: 'actual-llm', apiKey: 'route-key', alias: 'requested-alias' } } };
 const proxy = await serve(createProxyServer(config).listeners('request')[0]);
 t.after(async () => { await close(proxy.server); await close(backend.server); });
 const response = await post(proxy.url, { model: 'requested-alias', stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] });
 assert.equal(response.status, 200);
 assert.equal((await response.json()).content[0].text, 'selected');
 assert.deepEqual(seen, [{ path: '/v1/chat/completions', model: 'actual-llm', authorization: 'Bearer route-key' }]);
 const unknown = await post(proxy.url, { model: 'missing', stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] });
 assert.equal(unknown.status, 400);
 assert.equal(seen.length, 1);
});

test('V0.29.66 parallel OpenAI routes preserve endpoint, credentials, and model for streaming and non-streaming', async t => {
  const seen = [];
  const makeBackend = async (label) => serve(async (req, res) => {
    const body = await reqBody(req);
    seen.push({ label, path: req.url, model: body.model, key: req.headers.authorization, stream: body.stream });
    await new Promise(resolve => setTimeout(resolve, label === 'A' ? 25 : 5));
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', content: label }, 'stop') + 'data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: label, model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: label } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    }
  });
  const a = await makeBackend('A');
  const b = await makeBackend('B');
  const config = options('http://127.0.0.1:1/v1');
  config.modelRouting = { enabled: true, unknownModel: 'reject', routes: {
    'alias-a': { url: a.url + '/v1', protocol: 'openai', model: 'model-a', apiKey: 'key-a', alias: 'alias-a' },
    'alias-b': { url: b.url + '/v1', protocol: 'openai', model: 'model-b', apiKey: 'key-b', alias: 'alias-b' },
  } };
  const proxy = await serve(createProxyServer(config).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(a.server); await close(b.server); });
  const [r1, r2, r3, r4] = await Promise.all([
    post(proxy.url, { model: 'alias-a', stream: false, max_tokens: 32, messages: [{ role: 'user', content: 'a1' }] }),
    post(proxy.url, { model: 'alias-b', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'b1' }] }),
    post(proxy.url, { model: 'alias-a', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'a2' }] }),
    post(proxy.url, { model: 'alias-b', stream: false, max_tokens: 32, messages: [{ role: 'user', content: 'b2' }] }),
  ]);
  assert.deepEqual([r1.status, r2.status, r3.status, r4.status], [200, 200, 200, 200]);
  assert.equal((await r1.json()).content[0].text, 'A');
  assert.match(await r2.text(), /"text":"B"/);
  assert.match(await r3.text(), /"text":"A"/);
  assert.equal((await r4.json()).content[0].text, 'B');
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.filter(x => x.label === 'A').map(x => [x.path, x.model, x.key]).sort(), [
    ['/v1/chat/completions', 'model-a', 'Bearer key-a'],
    ['/v1/chat/completions', 'model-a', 'Bearer key-a'],
  ]);
  assert.deepEqual(seen.filter(x => x.label === 'B').map(x => [x.path, x.model, x.key]).sort(), [
    ['/v1/chat/completions', 'model-b', 'Bearer key-b'],
    ['/v1/chat/completions', 'model-b', 'Bearer key-b'],
  ]);
});
