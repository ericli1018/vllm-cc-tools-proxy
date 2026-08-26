import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createMediaAdapters } from '../src/proxy/media-adapters.js';
import { prepareMediaHandles } from '../src/proxy/media-preflight.js';

function baseAdapterConfig(overrides = {}) {
  return {
    limits: { maxDecodedBytes: 5_000_000, maxOutputChars: 10_000, maxImagePixels: 20_000_000, processTimeoutMs: 20_000 },
    cache: { pipelineVersion: 'media-v8', visualPromptVersion: 'visual-v18', evidenceContractVersion: 'evidence-v14' },
    resourceProfile: 'default',
    vllmVisionUrl: 'http://vision:8000',
    vllmVisionModel: 'vision-model',
    vllmVisionApiKey: '',
    vllmVisionProvider: 'ollama',
    vllmVisionThink: false,
    vllmVisionTimeoutMs: 120000,
    vllmVisionApiProtocol: 'ollama-native',
    vllmBaseVisionEnabled: false,
    visionNativePassthrough: false,
    ...overrides,
  };
}

function fakeProgress(sourceKind, extra = {}) {
  return {
    contextForPath: () => ({
      filename: 'image.png',
      origin: sourceKind === 'read_image' || sourceKind === 'read_pdf_image' ? 'read' : sourceKind === 'tool_result_image' ? 'tool_result' : 'direct',
      originTool: sourceKind.startsWith('read_') ? 'Read' : '',
      sourceKind,
      readSourceRef: sourceKind.startsWith('read_') ? 'a'.repeat(64) : '',
      ...extra,
    }),
  };
}

async function makeImageAdapter({ sourceKind = 'direct_image', flags = true, source = 'base64' } = {}) {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  let visionCalls = 0;
  let cleanup = async () => {};
  let block;
  let allowedMediaPaths = new Set();
  if (source === 'proxy_file') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v02929-native-vision-'));
    const filePath = path.join(root, 'image.png');
    await fs.writeFile(filePath, png);
    allowedMediaPaths.add(filePath);
    cleanup = () => fs.rm(root, { recursive: true, force: true });
    block = { type: 'image', source: { type: 'proxy_file', media_type: 'image/png', path: filePath, cache_key: 'b'.repeat(64), media_sha256: 'c'.repeat(64) } };
  } else {
    block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  }
  const adapters = createMediaAdapters(baseAdapterConfig({
    vllmBaseVisionEnabled: flags,
    visionNativePassthrough: flags,
  }), undefined, undefined, {
    allowedMediaPaths,
    mediaProgress: fakeProgress(sourceKind),
    normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
    analyzeVisualAssets: async () => {
      visionCalls += 1;
      return { markdown: 'PROXY VISION EVIDENCE', warnings: [], cropCount: 0, needsZoom: false };
    },
  });
  return { png, block, adapters, cleanup, visionCalls: () => visionCalls };
}

test('V0.29.29 Native Vision routing ENV defaults are disabled and strict booleans enable both switches', () => {
  const defaults = loadConfig({ VLLM_BASE_URL: 'http://base:8000' });
  assert.equal(defaults.vllmBaseVisionEnabled, false);
  assert.equal(defaults.visionNativePassthrough, false);

  const enabled = loadConfig({
    VLLM_BASE_URL: 'http://base:8000',
    VLLM_BASE_VISION_ENABLED: 'true',
    VISION_NATIVE_PASSTHROUGH: 'true',
  });
  assert.equal(enabled.vllmBaseVisionEnabled, true);
  assert.equal(enabled.visionNativePassthrough, true);

  for (const key of ['VLLM_BASE_VISION_ENABLED', 'VISION_NATIVE_PASSTHROUGH']) {
    assert.throws(() => loadConfig({ VLLM_BASE_URL: 'http://base:8000', [key]: 'yes' }), new RegExp(key));
  }
});

test('V0.29.29 direct_image bypasses external Vision and preserves a clean Anthropic base64 image block', async () => {
  const fixture = await makeImageAdapter({ sourceKind: 'direct_image', flags: true });
  try {
    const output = await fixture.adapters.adaptImage(fixture.block, { path: ['messages', 0, 'content', 0] });
    assert.equal(output.type, 'image');
    assert.deepEqual(output.source, {
      type: 'base64',
      media_type: 'image/png',
      data: fixture.png.toString('base64'),
    });
    assert.equal(fixture.visionCalls(), 0);
  } finally { await fixture.cleanup(); }
});

test('V0.29.29 read_image bypasses external Vision when both Native Vision switches are enabled', async () => {
  const fixture = await makeImageAdapter({ sourceKind: 'read_image', flags: true });
  try {
    const output = await fixture.adapters.adaptImage(fixture.block, { path: ['messages', 1, 'content', 0, 'content', 0] });
    assert.equal(output.type, 'image');
    assert.equal(output.source.media_type, 'image/png');
    assert.equal(output.source.data, fixture.png.toString('base64'));
    assert.equal(fixture.visionCalls(), 0);
  } finally { await fixture.cleanup(); }
});

test('V0.29.29 Native Vision rehydrates request-scoped proxy_file images without leaking internal path metadata', async () => {
  const fixture = await makeImageAdapter({ sourceKind: 'direct_image', flags: true, source: 'proxy_file' });
  try {
    const output = await fixture.adapters.adaptImage(fixture.block, { path: ['messages', 0, 'content', 0] });
    assert.equal(output.type, 'image');
    assert.equal(output.source.type, 'base64');
    assert.equal(output.source.data, fixture.png.toString('base64'));
    assert.equal('path' in output.source, false);
    assert.equal('cache_key' in output.source, false);
    assert.equal('media_sha256' in output.source, false);
    assert.equal(fixture.visionCalls(), 0);
  } finally { await fixture.cleanup(); }
});

test('V0.29.29 read_pdf_image remains on the existing Proxy Vision pipeline', async () => {
  const fixture = await makeImageAdapter({ sourceKind: 'read_pdf_image', flags: true });
  try {
    const output = await fixture.adapters.adaptImage(fixture.block, { path: ['messages', 1, 'content', 0, 'content', 0] });
    assert.equal(output.type, 'text');
    assert.match(output.text, /PROXY VISION EVIDENCE/);
    assert.equal(fixture.visionCalls(), 1);
  } finally { await fixture.cleanup(); }
});

test('V0.29.29 generic tool_result_image remains on Proxy Vision instead of being guessed as a UI screenshot', async () => {
  const fixture = await makeImageAdapter({ sourceKind: 'tool_result_image', flags: true });
  try {
    const output = await fixture.adapters.adaptImage(fixture.block, { path: ['messages', 1, 'content', 0, 'content', 0] });
    assert.equal(output.type, 'text');
    assert.match(output.text, /PROXY VISION EVIDENCE/);
    assert.equal(fixture.visionCalls(), 1);
  } finally { await fixture.cleanup(); }
});

test('V0.29.29 either disabled Native Vision switch preserves V0.29.28 Proxy Vision behavior', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  for (const overrides of [
    { vllmBaseVisionEnabled: false, visionNativePassthrough: true },
    { vllmBaseVisionEnabled: true, visionNativePassthrough: false },
  ]) {
    let visionCalls = 0;
    const adapters = createMediaAdapters(baseAdapterConfig(overrides), undefined, undefined, {
      mediaProgress: fakeProgress('direct_image'),
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'OLD PIPELINE', warnings: [], cropCount: 0, needsZoom: false }; },
    });
    const output = await adapters.adaptImage({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }, { path: ['messages', 0, 'content', 0] });
    assert.equal(output.type, 'text');
    assert.match(output.text, /OLD PIPELINE/);
    assert.equal(visionCalls, 1);
  }
});

import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer } from '../src/services/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function proxyConfig(overrides = {}) {
  return {
    host: '127.0.0.1', port: 0, resourceProfile: 'default', responseLanguage: 'en-US',
    limits: { maxRequestBytes: 5_000_000, maxDecodedBytes: 5_000_000, maxPdfPages: 20, maxOutputChars: 100_000, processTimeoutMs: 20_000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20_000_000, maxVisualPagesPerBatch: 4 },
    cache: { rootDir: path.join(os.tmpdir(), `v02929-cache-${Math.random()}`), maxBytes: 0, retentionMs: 60_000, limitMode: 'filesystem', pipelineVersion: 'media-v8', visualPromptVersion: 'visual-v18', evidenceContractVersion: 'evidence-v14' },
    concurrency: { visionLimit: 1 },
    vllmBaseUrl: 'http://127.0.0.1:9', vllmBaseModel: '', vllmBaseApiKey: '', vllmBaseResponseMode: 'auto',
    vllmBaseTimeouts: { connectTimeoutMs: 10_000, headersTimeoutMs: 900_000, bodyTimeoutMs: 900_000 },
    vllmBaseVisionEnabled: true, visionNativePassthrough: true,
    vllmVisionUrl: 'http://vision.invalid', vllmVisionModel: 'vision-model', vllmVisionApiKey: '', vllmVisionProvider: 'ollama', vllmVisionThink: false, vllmVisionTimeoutMs: 120_000, vllmVisionApiProtocol: 'ollama-native',
    searxngUrl: '', webFetchUrl: '', webFetchApiKey: '',
    webFetchProcessor: { enabled: false, provider: 'vllm', url: '', model: '', apiKey: '', think: false, concurrency: 3, timeoutMs: 300_000 },
    langProcessor: { enabled: false, provider: 'vllm', url: '', model: '', apiKey: '', think: false, timeoutMs: 300_000 },
    contextCompact: { enabled: false, provider: 'vllm', url: '', model: '', apiKey: '', think: false },
    webToolDiagnostic: { enabled: false, trace: false, searchPassthroughCount: 0, fetchPassthroughCount: 0, traceDir: path.join(os.tmpdir(), 'v02929-web-trace') },
    maxToolRounds: 6, managedTaskTimeoutMs: 0, managedModelRoundTimeoutMs: 360_000, managedModelStallTimeoutMs: 90_000,
    progressVisibleAfterMs: 60_000, progressPingIntervalMs: 10_000, progressHeartbeatMs: 30_000, sseDrainTimeoutMs: 10_000,
    logLevel: 'error', logProtocolSnippets: false, gitRevision: 'test', usagePreflightEnabled: true,
    ...overrides,
  };
}

test('V0.29.29 Proxy sends eligible direct images natively to Base after a successful capability preflight', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    observed.push({ url: req.url, payload });
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(base64), true);
    assert.equal(serialized.includes('VCC_PROXY_EVIDENCE_BEGIN'), false);
    if (req.url.includes('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 123 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'native-ok', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'native vision ok' }], stop_reason: 'end_turn', usage: { input_tokens: 123, output_tokens: 4 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'SHOULD NOT RUN', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }, { type: 'text', text: 'inspect' }] }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'native vision ok');
  assert.equal(visionCalls, 0);
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages']);
});

test('V0.29.31 explicit Base image-capability rejection at /v1/messages falls back to the existing Proxy Vision pipeline', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    observed.push({ url: req.url, serialized });
    assert.equal(req.url, '/v1/messages');
    if (serialized.includes(base64)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'This model does not support image input.' } }));
      return;
    }
    assert.match(serialized, /FALLBACK VISION EVIDENCE/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fallback-ok', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'fallback ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const logs = [];
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl, logLevel: 'info', logSink: (entry) => logs.push(entry) }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'FALLBACK VISION EVIDENCE', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'fallback ok');
  assert.equal(visionCalls, 1);
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages', '/v1/messages']);
  assert.ok(logs.some((entry) => entry.event === 'native_vision_fallback_selected' && entry.reason === 'base_image_capability_rejected_runtime'));
});

test('V0.29.29 actual Claude Code Read(image) provenance routes the returned image to Base Native Vision', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    observed.push({ url: req.url, payload });
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(base64), true);
    assert.equal(serialized.includes('VCC_PROXY_EVIDENCE_BEGIN'), false);
    if (req.url.includes('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 77 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'read-native', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 77, output_tokens: 1 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'SHOULD NOT RUN', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-img-1', name: 'Read', input: { file_path: '/workspace/screenshots/home.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-img-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages }),
  });
  assert.equal(response.status, 200);
  assert.equal(visionCalls, 0);
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages']);
});

test('V0.29.29 actual Claude Code Read(PDF) image provenance stays on Proxy Vision', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  let observedBody = '';
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    observedBody = JSON.stringify(payload);
    assert.equal(req.url, '/v1/messages');
    assert.equal(observedBody.includes(base64), false);
    assert.match(observedBody, /READ PDF PAGE EVIDENCE/);
    assert.match(observedBody, /source_kind: \\\"read_pdf_image\\\"/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'read-pdf-image', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'READ PDF PAGE EVIDENCE', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-pdf-1', name: 'Read', input: { file_path: '/workspace/docs/board.pdf', pages: '3' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-pdf-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages }),
  });
  assert.equal(response.status, 200);
  assert.equal(visionCalls, 1);
});

test('V0.29.29 mixed Native and Proxy-routed images preserve the raw Native image while injecting evidence only for the Proxy-routed image', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(base64), true);
    assert.match(serialized, /MIXED PROXY EVIDENCE/);
    assert.match(serialized, /VCC_PROXY_EVIDENCE_CONTRACT_V1/);
    if (req.url.includes('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 88 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'mixed', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 88, output_tokens: 1 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'MIXED PROXY EVIDENCE', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-image', name: 'Bash', input: { command: 'make-image' } }] },
    { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
      { type: 'tool_result', tool_use_id: 'bash-image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] },
    ] },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages }),
  });
  assert.equal(response.status, 200);
  assert.equal(visionCalls, 1);
});

test('V0.29.31 Native raw route no longer depends on a full-image count_tokens probe', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  let countCalls = 0;
  let messageCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(base64), true);
    if (req.url.includes('/count_tokens')) {
      countCalls += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_error', message: 'Engine temporarily unavailable.' } }));
      return;
    }
    messageCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'probe-500-native-ok', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 90, output_tokens: 1 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const logs = [];
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl, logLevel: 'info', logSink: (entry) => logs.push(entry) }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'SHOULD NOT FALLBACK', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(visionCalls, 0);
  assert.equal(countCalls, 0);
  assert.equal(messageCalls, 1);
  assert.equal(logs.some((entry) => entry.event === 'native_vision_fallback_selected'), false);
  assert.equal(logs.some((entry) => entry.event === 'native_vision_base_probe_failed'), false);
});

test('V0.29.30 media preflight leaves explicitly bypassed Native Vision image blocks byte-for-byte untouched', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const canonical = png.toString('base64');
  const decorated = `${canonical.slice(0, 73)}\n${canonical.slice(73)}`;
  const pathValue = ['messages', 1, 'content', 0, 'content', 0];
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-raw-1', name: 'Read', input: { file_path: '/workspace/screenshots/raw.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-raw-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: decorated } }] }] },
  ];
  const original = structuredClone(messages);
  const prepared = await prepareMediaHandles(messages, { maxDecodedBytes: 5_000_000 }, {
    passthroughPaths: new Set([JSON.stringify(pathValue)]),
  });
  try {
    assert.deepEqual(prepared.messages, original);
    assert.equal(prepared.mediaEntries.length, 0);
    assert.equal(prepared.mediaOccurrences.length, 0);
  } finally {
    await prepared.cleanup();
  }
});

test('V0.29.30 Claude Code Read(image) reaches Base vLLM with the original tool_result image block unchanged', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const canonical = png.toString('base64');
  const decorated = `${canonical.slice(0, 61)}\n${canonical.slice(61)}`;
  const source = {
    type: 'base64',
    media_type: 'image/png',
    data: decorated,
    width: 600,
    height: 180,
  };
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-raw-2', name: 'Read', input: { file_path: '/workspace/screenshots/home.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-raw-2', content: [{ type: 'image', source }] }] },
  ];
  const expectedMessages = structuredClone(messages);
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    observed.push({ url: req.url, payload });
    assert.deepEqual(payload.messages, expectedMessages);
    assert.equal(JSON.stringify(payload).includes('proxy_file'), false);
    assert.equal(JSON.stringify(payload).includes('VCC_PROXY_EVIDENCE_BEGIN'), false);
    if (req.url.includes('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 91 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'raw-read-native', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'raw native ok' }], stop_reason: 'end_turn', usage: { input_tokens: 91, output_tokens: 3 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const logs = [];
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl, logLevel: 'info', logSink: (entry) => logs.push(entry) }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'SHOULD NOT RUN', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'raw native ok');
  assert.equal(visionCalls, 0);
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages']);
  assert.ok(logs.some((entry) => entry.event === 'native_vision_raw_passthrough_selected'));
});

test('V0.29.31 Native raw Read(image) sends the original image only to /v1/messages and skips full-image count_tokens probing', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    observed.push({ url: req.url, payload });
    if (req.url.includes('/count_tokens')) {
      assert.equal(JSON.stringify(payload).includes(base64), false, 'raw image must never be sent to count_tokens');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 12 }));
      return;
    }
    assert.equal(req.url, '/v1/messages');
    assert.equal(JSON.stringify(payload).includes(base64), true);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'native-direct-031', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 90, output_tokens: 1 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl }));
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-031', name: 'Read', input: { file_path: '/workspace/screenshot.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-031', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'ok');
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages']);
});

test('V0.29.31 explicit image-capability rejection from /v1/messages falls back once to Proxy Vision without a capability probe', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    observed.push({ url: req.url, serialized });
    assert.equal(req.url, '/v1/messages');
    if (serialized.includes(base64)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'This model does not support image input.' } }));
      return;
    }
    assert.match(serialized, /RUNTIME FALLBACK VISION EVIDENCE/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fallback-runtime-031', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'fallback ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const logs = [];
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl, logLevel: 'info', logSink: (entry) => logs.push(entry) }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'RUNTIME FALLBACK VISION EVIDENCE', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'fallback ok');
  assert.equal(visionCalls, 1);
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages', '/v1/messages']);
  assert.ok(logs.some((entry) => entry.event === 'native_vision_fallback_selected' && entry.reason === 'base_image_capability_rejected_runtime'));
});

test('V0.29.31 streaming Native raw Read(image) uses only placeholder usage bootstrap before sending the original image to /v1/messages', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    observed.push({ url: req.url, payload, serialized });
    if (req.url === '/v1/messages/count_tokens') {
      assert.equal(serialized.includes(base64), false);
      assert.match(serialized, /VCC pending image evidence/);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 70 }));
      return;
    }
    assert.equal(req.url, '/v1/messages');
    assert.equal(serialized.includes(base64), true);
    assert.equal(payload.stream, true);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m031","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":90,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  const logs = [];
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl, logLevel: 'info', logSink: (entry) => logs.push(entry) }));
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-stream-031', name: 'Read', input: { file_path: '/workspace/screenshot.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-stream-031', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OK/);
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages/count_tokens', '/v1/messages']);
  assert.ok(logs.some((entry) => entry.event === 'native_vision_image_probe_skipped'));
  assert.equal(logs.some((entry) => entry.event === 'native_vision_base_probe_succeeded'), false);
});

test('V0.29.31 empty Native Vision SSE recovery logs the upstream event fingerprint and keeps raw image off count_tokens', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  let messageCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    if (req.url === '/v1/messages/count_tokens') {
      assert.equal(serialized.includes(base64), false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 70 }));
      return;
    }
    assert.equal(req.url, '/v1/messages');
    assert.equal(serialized.includes(base64), true);
    messageCalls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (messageCalls === 1) {
      res.end([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"empty031","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"usage":{"input_tokens":90,"output_tokens":0}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(''));
      return;
    }
    res.end([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"ok031","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"usage":{"input_tokens":90,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"RECOVERED"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  const logs = [];
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl, logLevel: 'info', logSink: (entry) => logs.push(entry) }));
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const tools = [
    { name: 'WebSearch', description: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'WebFetch', description: 'fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
  ];
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-empty-031', name: 'Read', input: { file_path: '/workspace/screenshot.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-empty-031', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, output_config: { effort: 'xhigh' }, tools, messages }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /RECOVERED/);
  assert.equal(messageCalls, 2);
  const start = logs.find((entry) => entry.event === 'managed_empty_end_turn_regeneration_started');
  assert.ok(start);
  assert.equal(start.requested_effort, 'xhigh');
  assert.deepEqual(start.sse_event_sequence, ['message_start', 'message_delta', 'message_stop']);
  assert.deepEqual(start.sse_event_counts, { message_start: 1, message_delta: 1, message_stop: 1 });
  assert.equal(start.sse_content_block_count, 0);
});

test('V0.29.31 streaming Native Vision without managed tools falls back on /v1/messages capability rejection', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    observed.push({ url: req.url, serialized });
    if (req.url === '/v1/messages/count_tokens') {
      assert.equal(serialized.includes(base64), false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 70 }));
      return;
    }
    if (serialized.includes(base64)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'This model does not support image input.' } }));
      return;
    }
    assert.match(serialized, /STREAM FALLBACK EVIDENCE/);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"sf031","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":70,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"FALLBACK_OK"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(''));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  let visionCalls = 0;
  const logs = [];
  const proxy = createProxyServer(proxyConfig({ vllmBaseUrl: upstreamUrl, logLevel: 'info', logSink: (entry) => logs.push(entry) }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
      analyzeVisualAssets: async () => { visionCalls += 1; return { markdown: 'STREAM FALLBACK EVIDENCE', warnings: [], cropCount: 0, needsZoom: false }; },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /FALLBACK_OK/);
  assert.equal(visionCalls, 1);
  assert.deepEqual(observed.map((entry) => entry.url), ['/v1/messages/count_tokens', '/v1/messages', '/v1/messages']);
  assert.ok(logs.some((entry) => entry.event === 'native_vision_fallback_selected' && entry.reason === 'base_image_capability_rejected_runtime'));
});

test('V0.29.32 Native raw Read(image) hides media/file progress and exposes only model progress', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const base64 = png.toString('base64');
  const upstream = http.createServer(async (req, res) => {
    const payload = JSON.parse(await readRequest(req));
    const serialized = JSON.stringify(payload);
    if (req.url === '/v1/messages/count_tokens') {
      assert.equal(serialized.includes(base64), false);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 70 }));
      return;
    }
    assert.equal(req.url, '/v1/messages');
    assert.equal(serialized.includes(base64), true);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => res.end([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"clean032","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":90,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"看圖"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')), 20);
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => upstream.close());
  const logs = [];
  const proxy = createProxyServer(proxyConfig({
    vllmBaseUrl: upstreamUrl,
    responseLanguage: 'zh-TW',
    progressVisibleAfterMs: 0,
    logLevel: 'info',
    logSink: (entry) => logs.push(entry),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => proxy.close());
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-clean-032', name: 'Read', input: { file_path: '/workspace/preview.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-clean-032', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] },
  ];
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages }),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /OK/);
  assert.doesNotMatch(stream, /檔案：preview\.png/);
  assert.doesNotMatch(stream, /圖片 1\/1/);
  assert.doesNotMatch(stream, /文件與圖片內容已就緒/);
  assert.equal(logs.some((entry) => entry.event === 'managed_task_progress' && ['media_cache_miss', 'media_ready'].includes(entry.phase)), false);
  assert.match(stream, /模型開始思考/);
});
