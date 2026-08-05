import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { executeManagedTool, isManagedToolName, normalizeManagedToolName } from '../src/proxy/web-tools.js';

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('managed tool aliases normalize consistently', () => {
  assert.equal(isManagedToolName('WebSearch'), true);
  assert.equal(isManagedToolName('web_search'), true);
  assert.equal(normalizeManagedToolName('web_search'), 'WebSearch');
  assert.equal(isManagedToolName('Read'), false);
});

test('WebSearch calls SearXNG and bounds normalized results', async (t) => {
  const searx = await startServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('q'), 'vllm tools');
    assert.equal(url.searchParams.get('format'), 'json');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Official', url: 'https://example.com/doc', content: 'summary', publishedDate: '2026-08-01' }] }));
  });
  t.after(() => searx.server.close());
  const result = await executeManagedTool({ name: 'web_search', input: { query: 'vllm tools' } }, {
    searxngUrl: searx.url, webFetchUrl: '', limits: { maxOutputChars: 10000 },
  });
  assert.equal(result.query, 'vllm tools');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Official');
});

test('WebFetch rejects loopback targets before calling fetch backend', async () => {
  await assert.rejects(
    executeManagedTool({ name: 'WebFetch', input: { url: 'http://127.0.0.1/private' } }, {
      searxngUrl: '', webFetchUrl: 'http://fetch:8080', limits: { maxOutputChars: 10000 },
    }),
    /not allowed/,
  );
});
