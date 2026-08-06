import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { requestBaseUpstream } from '../src/services/base-upstream.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const timeouts = { connectTimeoutMs: 200, headersTimeoutMs: 25, bodyTimeoutMs: 25 };

test('Base upstream classifies delayed response headers', async (t) => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }, 80);
  });
  const url = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    requestBaseUpstream(`${url}/v1/messages`, { method: 'POST', body: '{}' }, timeouts),
    (error) => error.code === 'vllm_headers_timeout' && error.status === 504,
  );
});

test('Base upstream classifies response body idle timeout', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first');
    setTimeout(() => {
      if (!res.destroyed) res.end('second');
    }, 80);
  });
  const url = await listen(server);
  t.after(() => server.close());

  const response = await requestBaseUpstream(`${url}/v1/messages`, { method: 'POST', body: '{}' }, timeouts);
  await assert.rejects(
    response.text(),
    (error) => error.code === 'vllm_body_timeout' && error.status === 504,
  );
});

test('Base upstream classifies connection refusal', async () => {
  const probe = http.createServer();
  const url = await listen(probe);
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  await assert.rejects(
    requestBaseUpstream(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' }, timeouts),
    (error) => error.code === 'vllm_connection_refused' && error.status === 502,
  );
});

test('Base upstream exposes a fetch-compatible streaming facade', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(201, { 'content-type': 'text/event-stream', 'x-test': 'yes' });
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const url = await listen(server);
  t.after(() => server.close());

  const response = await requestBaseUpstream(`${url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }, timeouts);
  assert.equal(response.status, 201);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('x-test'), 'yes');
  assert.match(await response.text(), /message_stop/);
});
