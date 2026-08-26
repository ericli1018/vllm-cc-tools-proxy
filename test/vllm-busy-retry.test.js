import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer } from '../src/services/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function read(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function startServer(handler) {
  const server = http.createServer(handler);
  const url = await listen(server);
  return { server, url };
}
function config(vllmBaseUrl, overrides = {}) {
  return {
    host: '127.0.0.1', port: 0, resourceProfile: 'default',
    limits: { maxRequestBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxPdfPages: 20, maxOutputChars: 100000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20_000_000, maxVisualPagesPerBatch: 4 },
    vllmBaseUrl, vllmBaseApiKey: '',
    vllmBaseTimeouts: { connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000 },
    vllmBusyRetryIntervalMs: 20,
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
    searxngUrl: '', webFetchUrl: '', webFetchApiKey: '', maxToolRounds: 6,
    progressVisibleAfterMs: 0, progressPingIntervalMs: 10000, progressHeartbeatMs: 15000,
    concurrency: { profile: 'test', managedLimit: 1, queueLimit: 0, queueTimeoutMs: 50, visionLimit: 1 },
    logLevel: 'error', gitRevision: 'test', usagePreflightEnabled: false, responseLanguage: 'zh-TW',
    ...overrides,
  };
}

function successMessage(text = 'ok') {
  return { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
}

test('explicit vLLM 429 busy is retried per request until accepted', async (t) => {
  let calls = 0;
  const upstream = await startServer(async (req, res) => {
    await read(req);
    calls += 1;
    if (calls < 3) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_busy', message: 'server is busy' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(successMessage('accepted')));
  });
  const proxy = createProxyServer(config(upstream.url));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close()); t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'accepted');
  assert.equal(calls, 3);
});

test('streaming vLLM busy wait reports progress and then continues the same connection', async (t) => {
  let calls = 0;
  const upstream = await startServer(async (req, res) => {
    const body = JSON.parse((await read(req)).toString());
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_busy', message: 'capacity unavailable' } }));
      return;
    }
    assert.equal(body.stream, true);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(''));
  });
  const proxy = createProxyServer(config(upstream.url));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close()); t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /模型目前忙碌/);
  assert.match(text, /正在重試/);
  assert.match(text, /OK/);
  assert.match(text, /event: message_stop/);
  assert.equal(calls, 2);
});

test('non-busy 503 is not retried', async (t) => {
  let calls = 0;
  const upstream = await startServer(async (req, res) => {
    await read(req); calls += 1;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'engine_error', message: 'model failed to initialize tensor state' } }));
  });
  const proxy = createProxyServer(config(upstream.url));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close()); t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.notEqual(response.status, 200);
  assert.equal(calls, 1);
});

test('managed model first-byte deadline pauses during explicit busy retry wait', async (t) => {
  let modelCalls = 0;
  const upstream = await startServer(async (req, res) => {
    const body = JSON.parse((await read(req)).toString());
    modelCalls += 1;
    if (modelCalls <= 2) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_busy', message: 'server busy' } }));
      return;
    }
    const hasToolResult = body.messages.some((message) => Array.isArray(message.content)
      && message.content.some((block) => block.type === 'tool_result'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hasToolResult
      ? successMessage('managed-done')
      : { id: 'tool', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const searx = await startServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const proxy = createProxyServer(config(upstream.url, {
    searxngUrl: searx.url,
    managedModelRoundTimeoutMs: 30,
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close()); t.after(() => searx.server.close()); t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: 'search' }],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.content.find((block) => block.type === 'text')?.text, 'managed-done');
  assert.ok(modelCalls >= 4);
});
