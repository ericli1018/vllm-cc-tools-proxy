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

async function startServer(handler) {
  const server = http.createServer(handler);
  const url = await listen(server);
  return { server, url };
}

async function read(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
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
    searxngUrl: '', webFetchUrl: '', webFetchApiKey: '', maxToolRounds: 6,
    progressVisibleAfterMs: 60_000, progressPingIntervalMs: 10_000, progressHeartbeatMs: 15_000,
    concurrency: { visionLimit: 1 },
    logLevel: 'info', gitRevision: 'test', usagePreflightEnabled: false, responseLanguage: 'zh-TW',
    ...overrides,
  };
}

function jsonMessage(content, stopReason = 'tool_use') {
  return {
    id: 'msg-capability', type: 'message', role: 'assistant', model: 'm',
    content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function sseEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test('V0.29.27 observes ToolSearch and fingerprints deferred tool catalogs without mutating the request', async (t) => {
  const logs = [];
  let upstreamBody = null;
  const upstream = await startServer(async (req, res) => {
    upstreamBody = JSON.parse((await read(req)).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonMessage([
      { type: 'tool_use', id: 'tool-1', name: 'mcp__weather__get_weather', input: { city: 'Taipei' } },
    ])));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: upstream.url,
    logSink: (entry) => logs.push(structuredClone(entry)),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const body = {
    model: 'm', stream: false,
    tools: [
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
      {
        name: 'mcp__weather__get_weather', description: 'Get weather', defer_loading: true,
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
      {
        name: 'mcp__github__search_issues', description: 'Search issues', defer_loading: true,
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ],
    messages: [{ role: 'user', content: 'weather' }],
  };

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  await response.json();

  assert.deepEqual(upstreamBody.tools, body.tools);
  const inventory = logs.find((entry) => entry.event === 'anthropic_server_capability_inventory');
  assert.ok(inventory);
  assert.equal(inventory.server_tool_count, 1);
  assert.equal(inventory.tool_search_count, 1);
  assert.equal(inventory.discovery_only_count, 1);
  assert.equal(inventory.unsupported_count, 0);

  const observed = logs.find((entry) => entry.event === 'tool_search_request_observed');
  assert.ok(observed);
  assert.deepEqual(observed.variants, ['regex']);
  assert.equal(observed.deferred_tool_count, 2);
  assert.equal(observed.eager_tool_count, 1);
  assert.equal(observed.total_tool_count, 3);
  assert.match(observed.tool_catalog_sha256, /^[a-f0-9]{64}$/);
});

test('V0.29.27 emits explicit diagnostics for known unsupported Anthropic server tool declarations', async (t) => {
  const logs = [];
  let upstreamCalls = 0;
  const upstream = await startServer(async (req, res) => {
    upstreamCalls += 1;
    await read(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonMessage([
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/project/a' } },
    ])));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: upstream.url,
    logSink: (entry) => logs.push(structuredClone(entry)),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false,
      tools: [
        { type: 'code_execution_20260521', name: 'code_execution' },
        { type: 'advisor_20260301', name: 'advisor' },
        { type: 'mcp_toolset', name: 'mcp' },
      ],
      messages: [{ role: 'user', content: 'inspect capabilities' }],
    }),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(upstreamCalls, 1);

  const inventory = logs.find((entry) => entry.event === 'anthropic_server_capability_inventory');
  assert.ok(inventory);
  assert.equal(inventory.unsupported_count, 3);
  assert.deepEqual(inventory.unsupported_families, ['advisor', 'code_execution', 'mcp_toolset']);

  const unsupported = logs.filter((entry) => entry.event === 'anthropic_server_tool_unsupported');
  assert.equal(unsupported.length, 3);
  assert.deepEqual(unsupported.map((entry) => entry.family).sort(), ['advisor', 'code_execution', 'mcp_toolset']);
  assert.ok(unsupported.every((entry) => entry.level === 'warn'));
});

test('V0.29.27 preserves streamed ToolSearch lifecycle blocks and reports tool_reference inventory', async (t) => {
  const logs = [];
  const upstream = await startServer(async (req, res) => {
    await read(req);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const events = [
      sseEvent('message_start', { type: 'message_start', message: {
        id: 'msg-search', type: 'message', role: 'assistant', model: 'm', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      } }),
      sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: {
        type: 'server_tool_use', id: 'srvtoolu_search', name: 'tool_search_tool_regex', input: {},
      } }),
      sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: {
        type: 'input_json_delta', partial_json: '{"pattern":"weather"}',
      } }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: {
        type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_search',
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: [{ type: 'tool_reference', tool_name: 'mcp__weather__get_weather' }],
        },
      } }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
      sseEvent('content_block_start', { type: 'content_block_start', index: 2, content_block: {
        type: 'tool_use', id: 'toolu_weather', name: 'mcp__weather__get_weather', input: {},
      } }),
      sseEvent('content_block_delta', { type: 'content_block_delta', index: 2, delta: {
        type: 'input_json_delta', partial_json: '{"city":"Taipei"}',
      } }),
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 2 }),
      sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ];
    for (const entry of events) res.write(entry);
    res.end();
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: upstream.url,
    logSink: (entry) => logs.push(structuredClone(entry)),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true,
      tools: [
        { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
        { name: 'mcp__weather__get_weather', description: 'Get weather', defer_loading: true, input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: 'weather' }],
    }),
  });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /"type":"tool_search_tool_result"/);
  assert.match(wire, /"type":"tool_reference"/);
  assert.match(wire, /"tool_name":"mcp__weather__get_weather"/);

  const inventory = logs.find((entry) => entry.event === 'anthropic_server_response_inventory');
  assert.ok(inventory);
  assert.equal(inventory.server_tool_use_count, 1);
  assert.equal(inventory.tool_search_result_count, 1);
  assert.equal(inventory.tool_reference_count, 1);
  assert.equal(inventory.unknown_server_tool_use_count, 0);
  assert.match(inventory.tool_reference_names_sha256, /^[a-f0-9]{64}$/);
});

test('V0.29.27 reports unknown response-side server_tool_use blocks without mutating them', async (t) => {
  const logs = [];
  const upstream = await startServer(async (req, res) => {
    await read(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonMessage([
      { type: 'server_tool_use', id: 'srvtoolu_future', name: 'future_server_tool', input: { mode: 'x' } },
    ], 'pause_turn')));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: upstream.url,
    logSink: (entry) => logs.push(structuredClone(entry)),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'future' }] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.content, [
    { type: 'server_tool_use', id: 'srvtoolu_future', name: 'future_server_tool', input: { mode: 'x' } },
  ]);

  const unknown = logs.find((entry) => entry.event === 'anthropic_server_tool_use_unknown');
  assert.ok(unknown);
  assert.equal(unknown.level, 'warn');
  assert.equal(unknown.server_tool_name, 'future_server_tool');
  assert.equal(unknown.server_tool_id, 'srvtoolu_future');
});
