import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { forwardTransparent, buildUpstreamUrl, filterRequestHeaders } from '../src/proxy/bypass.js';
import { classifyMessagesRequest } from '../src/proxy/managed-detector.js';

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

test('buildUpstreamUrl preserves arbitrary paths and query strings', () => {
  assert.equal(buildUpstreamUrl('http://vllm:8000', '/v1/models?limit=1000'), 'http://vllm:8000/v1/models?limit=1000');
  assert.equal(buildUpstreamUrl('http://vllm:8000/v1', '/v1/messages?beta=true'), 'http://vllm:8000/v1/messages?beta=true');
  assert.equal(buildUpstreamUrl('http://vllm:8000/v1/messages', '/v1/messages'), 'http://vllm:8000/v1/messages');
  assert.equal(buildUpstreamUrl('http://vllm:8000/v1/messages', '/version'), 'http://vllm:8000/version');
});

test('request headers remove hop-by-hop values and replace authorization', () => {
  const headers = filterRequestHeaders({
    host: 'proxy:8080', connection: 'keep-alive', 'transfer-encoding': 'chunked',
    authorization: 'Bearer incoming', 'content-type': 'application/json', 'x-custom': 'yes',
  }, 'base-key');
  assert.equal(headers.authorization, 'Bearer base-key');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-custom'], 'yes');
  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers['transfer-encoding'], undefined);
});

test('forwardTransparent preserves method, raw body, query, status, headers and stream chunks', async (t) => {
  let observed;
  const upstream = http.createServer(async (req, res) => {
    observed = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      custom: req.headers['x-custom'],
      body: await read(req),
    };
    res.writeHead(207, { 'content-type': 'text/event-stream', 'x-upstream': 'preserved' });
    res.write('event: one\ndata: first\n\n');
    setTimeout(() => res.end('event: two\ndata: second\n\n'), 10);
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());

  const proxy = http.createServer(async (req, res) => {
    const rawBody = await read(req);
    await forwardTransparent(req, res, {
      vllmBaseUrl: upstreamUrl,
      vllmBaseApiKey: 'base-key',
      limits: { maxRequestBytes: 1024 * 1024 },
    }, { rawBody });
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());

  const raw = Buffer.from('{"z":1, "a":2}\n');
  const response = await fetch(`${proxyUrl}/custom/path?q=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-custom': 'kept' },
    body: raw,
  });
  assert.equal(response.status, 207);
  assert.equal(response.headers.get('x-upstream'), 'preserved');
  assert.equal(await response.text(), 'event: one\ndata: first\n\nevent: two\ndata: second\n\n');
  assert.equal(observed.method, 'POST');
  assert.equal(observed.url, '/custom/path?q=1');
  assert.equal(observed.authorization, 'Bearer base-key');
  assert.equal(observed.custom, 'kept');
  assert.deepEqual(observed.body, raw);
});

test('managed detector only intercepts media and proxy-owned web tools', () => {
  assert.deepEqual(classifyMessagesRequest({ messages: [{ role: 'user', content: 'hi' }] }), {
    managed: false, reasons: [], mediaCount: { documents: 0, images: 0 },
  });
  assert.deepEqual(classifyMessagesRequest({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }],
  }), {
    managed: true, reasons: ['image_block'], mediaCount: { documents: 0, images: 1 },
  });
  assert.deepEqual(classifyMessagesRequest({ messages: [], tools: [{ name: 'Read' }, { name: 'Bash' }] }), {
    managed: false, reasons: [], mediaCount: { documents: 0, images: 0 },
  });
  assert.deepEqual(classifyMessagesRequest({ messages: [], tools: [{ name: 'web_search' }] }), {
    managed: true, reasons: ['managed_web_tool'], mediaCount: { documents: 0, images: 0 },
  });
});

test('managed detector distinguishes native web tools that require schema normalization', () => {
  assert.deepEqual(classifyMessagesRequest({
    messages: [],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
  }), {
    managed: true,
    reasons: ['managed_web_tool', 'native_web_tool'],
    mediaCount: { documents: 0, images: 0 },
  });
});
