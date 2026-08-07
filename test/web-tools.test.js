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

test('WebFetch uses the exact configured endpoint, awesome-web-fetch urls contract and Bearer auth', async (t) => {
  let observed;
  const backend = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      page_content: '# Headline\n\nStory body',
      metadata: {
        source: 'https://example.com/article',
        final_url: 'https://example.com/final',
        title: 'Headline',
        content_type: 'text/html',
        status_code: 200,
        browser_rendered: true,
      },
    }]));
  });
  t.after(() => backend.server.close());

  const result = await executeManagedTool({ name: 'WebFetch', input: { url: 'https://example.com/article' } }, {
    searxngUrl: '',
    webFetchUrl: `${backend.url}/custom/fetch`,
    webFetchApiKey: 'fetch-secret',
    limits: { maxOutputChars: 10000 },
  });

  assert.deepEqual(observed, {
    method: 'POST',
    url: '/custom/fetch',
    authorization: 'Bearer fetch-secret',
    contentType: 'application/json',
    body: { urls: ['https://example.com/article'] },
  });
  const { retrieved_at: retrievedAt, ...stableResult } = result;
  assert.match(retrievedAt, /^2026-|^20\d{2}-/);
  assert.deepEqual(stableResult, {
    requested_url: 'https://example.com/article',
    final_url: 'https://example.com/final',
    status: 200,
    title: 'Headline',
    content_type: 'text/html',
    markdown: '# Headline\n\nStory body',
    truncated: false,
    warnings: [],
    browser_rendered: true,
    fetch_backend: 'awesome-web-fetch',
  });
});

test('WebFetch backend rejection preserves safe status and detail', async (t) => {
  const backend = await startServer((_req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'urls is required' }));
  });
  t.after(() => backend.server.close());

  await assert.rejects(
    executeManagedTool({ name: 'WebFetch', input: { url: 'https://example.com/article' } }, {
      searxngUrl: '', webFetchUrl: backend.url, webFetchApiKey: '', limits: { maxOutputChars: 10000 },
    }),
    (error) => {
      assert.equal(error.code, 'web_fetch_error');
      assert.equal(error.status, 422);
      assert.equal(error.message, 'urls is required');
      assert.deepEqual(error.details, { upstream_status: 422, upstream_code: '' });
      return true;
    },
  );
});

test('WebFetch emits safe backend diagnostics without secrets or page content', async (t) => {
  const backend = await startServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ page_content: 'PRIVATE PAGE BODY', metadata: { status_code: 200, title: 'Title' } }]));
  });
  t.after(() => backend.server.close());
  const events = [];

  await executeManagedTool({ name: 'WebFetch', input: { url: 'https://example.com/news' } }, {
    searxngUrl: '', webFetchUrl: backend.url, webFetchApiKey: 'super-secret', limits: { maxOutputChars: 10000 },
  }, undefined, {
    onEvent: (event, fields) => events.push({ event, fields }),
  });

  assert.deepEqual(events.map((entry) => entry.event), [
    'web_fetch_upstream_request',
    'web_fetch_upstream_response',
  ]);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotMatch(serialized, /PRIVATE PAGE BODY/);
  assert.match(serialized, /example\.com/);
  assert.match(serialized, /127\.0\.0\.1/);
});

test('WebFetch rejection emits a safe rejected diagnostic', async (t) => {
  const backend = await startServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'robots denied', private_body: 'do not log' }));
  });
  t.after(() => backend.server.close());
  const events = [];

  await assert.rejects(
    executeManagedTool({ name: 'WebFetch', input: { url: 'https://example.com/news' } }, {
      searxngUrl: '', webFetchUrl: backend.url, webFetchApiKey: '', limits: { maxOutputChars: 10000 },
    }, undefined, {
      onEvent: (event, fields) => events.push({ event, fields }),
    }),
    /robots denied/,
  );

  assert.equal(events.at(-1).event, 'web_fetch_upstream_rejected');
  assert.equal(events.at(-1).fields.http_status, 403);
  assert.deepEqual(events.at(-1).fields.response_keys, ['detail', 'private_body']);
  assert.doesNotMatch(JSON.stringify(events), /do not log/);
});

test('WebFetch uses prompt-directed Processor with the current Base request model', async (t) => {
  let processorRequest;
  const fetchBackend = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      page_content: 'NAVIGATION JUNK\n\nVerified source fact',
      metadata: {
        final_url: 'https://example.com/final',
        title: 'Fetched title',
        content_type: 'text/html',
        status_code: 200,
      },
    }]));
  });
  const processor = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    processorRequest = {
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Processed verified fact' } }] }));
  });
  t.after(() => fetchBackend.server.close());
  t.after(() => processor.server.close());
  const events = [];

  const result = await executeManagedTool({
    name: 'WebFetch',
    input: { url: 'https://example.com/article', prompt: 'Extract only verified facts.' },
  }, {
    searxngUrl: '',
    webFetchUrl: fetchBackend.url,
    webFetchApiKey: '',
    webFetchProcessor: {
      enabled: true,
      url: processor.url,
      model: '',
      apiKey: 'processor-key',
      think: false,
    },
    limits: { maxOutputChars: 10000 },
  }, undefined, {
    model: 'main-model',
    onEvent: (event, fields) => events.push({ event, fields }),
  });

  assert.equal(processorRequest.authorization, 'Bearer processor-key');
  assert.equal(processorRequest.body.model, 'main-model');
  assert.match(processorRequest.body.messages[1].content, /Extract only verified facts/);
  assert.match(processorRequest.body.messages[1].content, /Verified source fact/);
  assert.equal(result.processing.mode, 'prompt_directed');
  assert.equal(result.result, 'Processed verified fact');
  assert.equal('markdown' in result, false);
  assert.deepEqual(events.map((entry) => entry.event), [
    'web_fetch_upstream_request',
    'web_fetch_upstream_response',
    'web_fetch_processor_request',
    'web_fetch_processor_response',
  ]);
});

test('WebSearch enforces native allowed and blocked domain policy on results', async (t) => {
  const searx = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { title: 'Allowed', url: 'https://docs.example.com/docs/a', content: 'ok' },
      { title: 'Wrong path', url: 'https://example.com/blog/a', content: 'no' },
      { title: 'Blocked', url: 'https://private.example.com/docs/a', content: 'no' },
    ] }));
  });
  t.after(() => searx.server.close());
  const result = await executeManagedTool({ name: 'web_search', input: { query: 'policy' } }, {
    searxngUrl: searx.url, webFetchUrl: '', limits: { maxOutputChars: 10000 },
  }, undefined, {
    policy: {
      allowedDomains: ['example.com/docs'],
      blockedDomains: ['private.example.com'],
    },
  });
  assert.deepEqual(result.results.map((entry) => entry.title), ['Allowed']);
  assert.equal(result.filtered_result_count, 2);
});

test('WebFetch enforces blocked domain policy before calling backend', async () => {
  await assert.rejects(
    executeManagedTool({ name: 'web_fetch', input: { url: 'https://private.example.com/a' } }, {
      searxngUrl: '', webFetchUrl: 'http://fetch:8080', limits: { maxOutputChars: 10000 },
    }, undefined, {
      policy: { allowedDomains: [], blockedDomains: ['example.com'] },
    }),
    (error) => {
      assert.equal(error.code, 'blocked_web_domain');
      assert.equal(error.status, 422);
      return true;
    },
  );
});

test('WebFetch applies max_content_tokens as a conservative output cap', async (t) => {
  const backend = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ page_content: 'x'.repeat(1000), metadata: { status_code: 200 } }]));
  });
  t.after(() => backend.server.close());
  const result = await executeManagedTool({ name: 'web_fetch', input: { url: 'https://example.com/a' } }, {
    searxngUrl: '', webFetchUrl: backend.url, webFetchApiKey: '', limits: { maxOutputChars: 10000 },
  }, undefined, {
    policy: { allowedDomains: [], blockedDomains: [], maxContentTokens: 10 },
  });
  assert.equal(result.markdown.length, 40);
  assert.equal(result.truncated, true);
});
