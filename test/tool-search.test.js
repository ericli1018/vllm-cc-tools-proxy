import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer } from '../src/services/proxy-server.js';
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

async function startServer(handler) {
  const server = http.createServer(handler);
  const url = await listen(server);
  return { server, url };
}

function config(overrides = {}) {
  return {
    host: '127.0.0.1', port: 0, resourceProfile: 'default',
    limits: {
      maxRequestBytes: 4 * 1024 * 1024,
      maxDecodedBytes: 4 * 1024 * 1024,
      maxPdfPages: 20,
      maxOutputChars: 100000,
      processTimeoutMs: 20000,
      nativeTextMinCharsPerPage: 80,
      maxImagePixels: 20_000_000,
      maxVisualPagesPerBatch: 4,
    },
    vllmBaseApiKey: '',
    vllmBaseTimeouts: { connectTimeoutMs: 10000, headersTimeoutMs: 900000, bodyTimeoutMs: 900000 },
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
    searxngUrl: 'http://127.0.0.1:9', webFetchUrl: 'http://127.0.0.1:9', webFetchApiKey: '', maxToolRounds: 6,
    progressVisibleAfterMs: 60_000, progressPingIntervalMs: 10_000, progressHeartbeatMs: 15_000,
    concurrency: { visionLimit: 1 },
    logLevel: 'info', gitRevision: 'test', usagePreflightEnabled: false, responseLanguage: 'zh-TW',
    ...overrides,
  };
}

function jsonMessage(content, stopReason = 'tool_use') {
  return {
    id: 'msg-tool-search', type: 'message', role: 'assistant', model: 'm',
    content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const inputSchema = (properties = {}) => ({ type: 'object', properties });

function names(tools) {
  return (tools || []).map((tool) => tool?.name || tool?.type || '');
}

test('V0.29.28 classifies ToolSearch as managed even without web/media tools', () => {
  const classified = classifyMessagesRequest({
    messages: [{ role: 'user', content: 'find a repository tool' }],
    tools: [
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      { name: 'mcp__github__search_code', description: 'Search GitHub code', defer_loading: true, input_schema: inputSchema() },
    ],
  });
  assert.equal(classified.managed, true);
  assert.ok(classified.reasons.includes('tool_search'));
});

test('V0.29.28 keeps core/web tools eager, hides deferred tools, and locally resolves BM25 ToolSearch', async (t) => {
  const upstreamBodies = [];
  const upstream = await startServer(async (req, res) => {
    const body = JSON.parse((await read(req)).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify(jsonMessage([
        {
          type: 'tool_use', id: 'tool-search-1', name: 'tool_search_tool_bm25',
          input: { query: 'github repository issue search', limit: 1 },
        },
      ])));
      return;
    }
    res.end(JSON.stringify(jsonMessage([
      { type: 'tool_use', id: 'tool-gh-1', name: 'mcp__github__search_issues', input: { query: 'bug' } },
    ])));
  });
  const logs = [];
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url, logSink: (entry) => logs.push(structuredClone(entry)) }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const request = {
    model: 'm', stream: false,
    tools: [
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      { name: 'Read', description: 'Read a file', input_schema: inputSchema({ file_path: { type: 'string' } }) },
      { type: 'web_search_20250305', name: 'web_search', defer_loading: true },
      { type: 'web_fetch_20250910', name: 'web_fetch', defer_loading: true },
      {
        name: 'mcp__github__search_issues', description: 'Search issues in GitHub repositories', defer_loading: true,
        input_schema: inputSchema({ query: { type: 'string', description: 'GitHub issue search query' } }),
      },
      {
        name: 'mcp__jira__search_issues', description: 'Search Jira project issues', defer_loading: true,
        input_schema: inputSchema({ jql: { type: 'string', description: 'Jira query language expression' } }),
      },
    ],
    messages: [{ role: 'user', content: 'Find a GitHub issue' }],
  };

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(upstreamBodies.length, 2);
  const firstNames = names(upstreamBodies[0].tools);
  assert.ok(firstNames.includes('tool_search_tool_bm25'));
  assert.ok(firstNames.includes('Read'));
  assert.ok(firstNames.includes('web_search'));
  assert.ok(firstNames.includes('web_fetch'));
  assert.ok(!firstNames.includes('mcp__github__search_issues'));
  assert.ok(!firstNames.includes('mcp__jira__search_issues'));
  assert.ok(upstreamBodies[0].tools.every((tool) => tool.defer_loading !== true));

  const secondNames = names(upstreamBodies[1].tools);
  assert.ok(secondNames.includes('mcp__github__search_issues'));
  assert.ok(!secondNames.includes('mcp__jira__search_issues'));
  assert.ok(upstreamBodies[1].messages.some((message) => Array.isArray(message.content)
    && message.content.some((block) => block?.type === 'tool_result' && block?.tool_use_id === 'tool-search-1')));

  assert.equal(payload.content[0].name, 'mcp__github__search_issues');
  const executed = logs.find((entry) => entry.event === 'local_tool_search_executed');
  assert.ok(executed);
  assert.equal(executed.variant, 'bm25');
  assert.deepEqual(executed.matched_tool_names, ['mcp__github__search_issues']);
});

test('V0.29.28 materializes a deferred tool already used in conversation history without searching again', async (t) => {
  let upstreamBody = null;
  const upstream = await startServer(async (req, res) => {
    upstreamBody = JSON.parse((await read(req)).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonMessage([{ type: 'text', text: 'done' }], 'end_turn')));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false,
      tools: [
        { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
        {
          name: 'mcp__github__search_code', description: 'Search GitHub source code', defer_loading: true,
          input_schema: inputSchema({ query: { type: 'string' } }),
        },
        {
          name: 'mcp__jira__get_issue', description: 'Get Jira issue', defer_loading: true,
          input_schema: inputSchema({ key: { type: 'string' } }),
        },
      ],
      messages: [
        { role: 'user', content: 'search it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'gh-old', name: 'mcp__github__search_code', input: { query: 'foo' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gh-old', content: 'result' }] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  await response.json();

  const upstreamNames = names(upstreamBody.tools);
  assert.ok(upstreamNames.includes('mcp__github__search_code'));
  assert.ok(!upstreamNames.includes('mcp__jira__get_issue'));
});

test('V0.29.28 leaves defer_loading requests untouched when ToolSearch is not declared', async (t) => {
  let upstreamBody = null;
  const upstream = await startServer(async (req, res) => {
    upstreamBody = JSON.parse((await read(req)).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonMessage([{ type: 'text', text: 'plain' }], 'end_turn')));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const originalTool = {
    name: 'mcp__github__search_code', description: 'Search GitHub source code', defer_loading: true,
    input_schema: inputSchema({ query: { type: 'string' } }),
  };
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, tools: [originalTool], messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(upstreamBody.tools, [originalTool]);
});

test('V0.29.28 executes local ToolSearch even when the request has no web or media tools', async (t) => {
  const upstreamBodies = [];
  const upstream = await startServer(async (req, res) => {
    const body = JSON.parse((await read(req)).toString('utf8'));
    upstreamBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (upstreamBodies.length === 1) {
      res.end(JSON.stringify(jsonMessage([
        { type: 'tool_use', id: 'search-only-1', name: 'tool_search_tool_regex', input: { pattern: 'weather', limit: 1 } },
      ])));
      return;
    }
    res.end(JSON.stringify(jsonMessage([
      { type: 'tool_use', id: 'weather-1', name: 'mcp__weather__get_weather', input: { city: 'Taipei' } },
    ])));
  });
  const logs = [];
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url, logSink: (entry) => logs.push(structuredClone(entry)) }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false,
      tools: [
        { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
        {
          name: 'mcp__weather__get_weather', description: 'Get current weather for a city', defer_loading: true,
          input_schema: inputSchema({ city: { type: 'string', description: 'City name' } }),
        },
      ],
      messages: [{ role: 'user', content: 'What is the weather?' }],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(upstreamBodies.length, 2);
  assert.ok(!names(upstreamBodies[0].tools).includes('mcp__weather__get_weather'));
  assert.ok(names(upstreamBodies[1].tools).includes('mcp__weather__get_weather'));
  assert.equal(payload.content[0].name, 'mcp__weather__get_weather');
  assert.equal(logs.find((entry) => entry.event === 'request_completed')?.managed, true);
});
