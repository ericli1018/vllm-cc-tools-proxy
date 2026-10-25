import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';
const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
const pdf = await fs.readFile(new URL('./fixtures/scanned.pdf', import.meta.url));
const read = async req => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks)); };
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const image = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
const document = () => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64'), filename: 'scan.pdf' } });
const compactPrompt = 'Your task is to create a detailed summary of the conversation so far. This summary will be used as context when continuing the conversation.';
const hasImages = body => /"type":"(?:image|image_url)"/.test(JSON.stringify(body));
async function serve(t, handler) {
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(err => json(res, { error: { message: err.message } }, 500)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
function answer(res, protocol, body, text, plan = false) {
  const input = { objective: 'Inspect image', questions: [{ id: 'q1', question: 'What is visible?' }] };
  const anth = { id: 'msg-test', type: 'message', role: 'assistant', model: body.model, content: plan ? [{ type: 'tool_use', id: 'plan', name: 'SubmitVisualPlan', input }] : [{ type: 'text', text }], stop_reason: plan ? 'tool_use' : 'end_turn', usage: { input_tokens: 23, output_tokens: 7 } };
  if (!body.stream || plan) {
    if (protocol === 'anthropic') return json(res, anth);
    return json(res, { id: 'chat-test', model: body.model, choices: [{ finish_reason: plan ? 'tool_calls' : 'stop', message: plan ? { role: 'assistant', content: null, tool_calls: [{ id: 'plan', type: 'function', function: { name: 'SubmitVisualPlan', arguments: JSON.stringify(input) } }] } : { role: 'assistant', content: text } }], usage: { prompt_tokens: 23, completion_tokens: 7 } });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (protocol === 'openai') {
    res.end(`data: ${JSON.stringify({ id: 'chat-test', model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`); return;
  }
  const event = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  res.end(event('message_start', { message: { ...anth, content: [], stop_reason: null } }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) + event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) + event('message_stop'));
}
async function setup(t, { protocol = 'anthropic', baseProtocol = 'openai', routes = {}, directed = true, rejectImage = 0, extraConfig = {}, externalCompact = false } = {}) {
  const seen = { base: [], route: [], vision: [], externalPdf: [], logs: [] };
  const make = (kind, protocol) => serve(t, async (req, res) => {
    const body = await read(req); seen[kind].push({ body, path: req.url, headers: req.headers });
    await delay(kind === 'route' ? 6 : 2);
    if (req.url.endsWith('/count_tokens')) return json(res, { input_tokens: 23 });
    if (kind === 'route' && rejectImage && hasImages(body)) return json(res, { error: { type: 'invalid_request_error', message: rejectImage === 400 ? 'At most 0 image(s) may be provided in one prompt.' : 'Service unavailable' } }, rejectImage);
    const plan = body.tools?.some(t => (t.name || t.function?.name) === 'SubmitVisualPlan');
    answer(res, protocol, body, `${kind.toUpperCase()}_OK`, plan);
  });
  const baseUrl = await make('base', baseProtocol);
  const routeUrl = await make('route', protocol);
  const visionUrl = await serve(t, async (req, res) => {
    seen.vision.push({ body: await read(req), headers: req.headers });
    json(res, { choices: [{ message: { content: JSON.stringify({ schema: 'visual_perception_v1', asset_id: 'visual-1', status: 'complete', answers: [{ question_id: 'q1', status: 'answered', answer: 'DEDICATED_VISION', evidence: [], uncertainty: '' }], follow_up_regions: [] }) } }] });
  });
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'route-http69-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const definitions = Object.fromEntries(Object.entries(Object.keys(routes).length ? routes : { alias: {} }).map(([alias, settings]) => [alias, { url: routeUrl + '/v1', protocol, model: `local-${alias}`, api_key: 'route-key', ...settings }]));
  const config = { ...loadConfig({
    VLLM_BASE_URL: baseUrl, VLLM_BASE_MODEL: 'base-model', VLLM_BASE_API_PROTOCOL: baseProtocol, VLLM_BASE_API_KEY: 'base-key',
    VLLM_MODEL_ROUTES: JSON.stringify(definitions), VLLM_MODEL_ROUTING_UNKNOWN_MODEL: 'fallback',
    VLLM_BASE_VISION_ENABLED: 'true', VISION_NATIVE_PASSTHROUGH: 'true', VISION_ORCHESTRATION_MODE: directed ? 'directed' : 'legacy',
    VLLM_VISION_URL: visionUrl, VLLM_VISION_MODEL: 'dedicated-vision', VLLM_VISION_API_KEY: 'vision-key',
    COMPLETION_PROBE_ENABLED: 'false', LANG_PROCESSOR_ENABLED: 'false', LOG_LEVEL: 'info',
  }), usagePreflightEnabled: false, logSink: e => seen.logs.push(e), progressVisibleAfterMs: 1, progressPingIntervalMs: 10,
    cache: { rootDir: cacheRoot, maxBytes: 0, retentionMs: 60000, pipelineVersion: 'media-v8', visualPromptVersion: 'visual-v18', evidenceContractVersion: 'evidence-v14' },
    ...(externalCompact ? { contextCompact: { enabled: true, provider: 'vllm', url: 'http://127.0.0.1:9', model: 'must-not-call', timeoutMs: 1000 } } : {}), ...extraConfig,
  };
  const proxy = createProxyServer(config, { mediaAdapterDependencies: {
    normalizeImage: async buffer => ({ buffer, mediaType: 'image/png', width: 600, height: 180 }),
    analyzeVisualAssets: async (assets, options) => { seen.externalPdf.push({ options, count: assets.length }); return { markdown: 'DEDICATED_PDF_VISION', warnings: [], cropCount: 0 }; },
  } });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const post = (body, endpoint = '/v1/messages') => fetch(url + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'client-key' }, body: JSON.stringify({ model: 'alias', stream: false, max_tokens: 128, ...body }) });
  return { seen, post, config, definitions };
}
for (const protocol of ['anthropic', 'openai']) for (const stream of [false, true]) for (const compact of [true, false]) {
  test(`V0.29.69 compact ${protocol} stream=${stream} compact_use_route=${compact}`, async t => {
    const { seen, post } = await setup(t, { protocol, baseProtocol: protocol === 'anthropic' ? 'openai' : 'anthropic', routes: { alias: { compact_use_route: compact } }, externalCompact: true });
    const res = await post({ stream, tools: [{ name: 'Read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: compactPrompt }] });
    const wire = await res.text(); assert.equal(res.status, 200, wire);
    assert.match(wire, compact ? /ROUTE_OK/ : /BASE_OK/);
    assert.equal(seen[compact ? 'base' : 'route'].length, 0);
    const call = seen[compact ? 'route' : 'base'][0];
    assert.equal(call.body.model, compact ? 'local-alias' : 'base-model');
    assert.equal(call.headers.authorization, `Bearer ${compact ? 'route-key' : 'base-key'}`);
    assert.notEqual(call.headers['x-api-key'], 'client-key');
    assert.equal(call.body.tools, undefined);
    assert.equal(call.body.stream, stream);
    assert.doesNotMatch(wire, /Processing ·|處理中 ·|SubmitCompletionDecision/);
    if (stream) assert.match(wire, /message_stop/);
    else assert.equal(JSON.parse(wire).usage.input_tokens, 23);
  });
}
for (const protocol of ['anthropic', 'openai']) for (const native of [true, false]) for (const kind of ['image', 'read-pdf', 'pdf']) {
  test(`V0.29.69 visual ${protocol} visual_use_route=${native} ${kind}`, async t => {
    const { seen, post } = await setup(t, { protocol, routes: { alias: { visual_use_route: native } } });
    const messages = kind === 'read-pdf' ? [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-pdf', name: 'Read', input: { file_path: '/private/scan.pdf', pages: '42' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-pdf', content: [{ type: 'text', text: 'Page 42' }, image()] }] },
    ] : [{ role: 'user', content: [kind === 'pdf' ? document() : image()] }];
    const res = await post({ messages }); const wire = await res.text();
    assert.equal(res.status, 200, wire); assert.match(wire, /ROUTE_OK/);
    assert.equal(seen.base.length, 0);
    const final = seen.route.at(-1);
    assert.equal(hasImages(final.body), native, wire);
    assert.equal(final.body.model, 'local-alias');
    assert.equal(final.headers.authorization, 'Bearer route-key');
    if (native) { assert.equal(seen.vision.length, 0); assert.equal(seen.externalPdf.length, 0); }
    else if (kind === 'pdf') { assert.ok(seen.externalPdf.length > 0); assert.ok(seen.externalPdf.every(c => c.options.model === 'dedicated-vision')); }
    else { assert.equal(seen.vision.length, 1); assert.equal(seen.vision[0].body.model, 'dedicated-vision'); }
    assert.doesNotMatch(JSON.stringify(final.body), /"type":"document"|"type":"proxy_file"|\/tmp\/vllm-cc/);
  });
}
test('V0.29.69 route vision_enabled=false uses dedicated Vision even with both global switches on', async t => {
  const { seen, post } = await setup(t, { routes: { alias: { vision_enabled: false } } });
  assert.equal((await post({ messages: [{ role: 'user', content: [image()] }] })).status, 200);
  assert.equal(seen.vision.length, 1); assert.equal(hasImages(seen.route.at(-1).body), false);
});
test('V0.29.69 count_tokens PDF and image invoke no generation/vision model', async t => {
  const { seen, post } = await setup(t, { routes: { alias: { visual_use_route: false } } });
  const res = await post({ messages: [{ role: 'user', content: [document(), image()] }] }, '/v1/messages/count_tokens');
  const wire = await res.text(); assert.equal(res.status, 200, wire);
  assert.equal(seen.externalPdf.length, 0); assert.equal(seen.vision.length, 0);
  assert.ok(seen.route.every(c => c.path.endsWith('/count_tokens')));
});
test('V0.29.69 mixed simultaneous compact and native/dedicated requests keep routes isolated', async t => {
  const { seen, post, config } = await setup(t, { routes: { native: {}, dedicated: { compact_use_route: false, visual_use_route: false } } });
  const original = JSON.stringify(config.modelRouting);
  const requests = await Promise.all([
    post({ model: 'native', stream: true, messages: [{ role: 'user', content: compactPrompt }] }),
    post({ model: 'dedicated', messages: [{ role: 'user', content: compactPrompt }] }),
    post({ model: 'native', messages: [{ role: 'user', content: [document()] }] }),
    post({ model: 'dedicated', messages: [{ role: 'user', content: [image()] }] }),
  ]);
  for (const res of requests) assert.equal(res.status, 200, await res.text());
  assert.equal(seen.base.length, 1); assert.equal(seen.base[0].body.model, 'base-model');
  assert.equal(seen.vision.length, 1);
  assert.ok(seen.route.filter(c => hasImages(c.body)).every(c => c.body.model === 'local-native'));
  assert.equal(JSON.stringify(config.modelRouting), original);
});

for (const status of [400, 503]) test(`V0.29.69 native PDF rejection ${status} ${status === 400 ? 'falls back once' : 'does not switch models'}`, async t => {
  const { seen, post } = await setup(t, { rejectImage: status });
  const res = await post({ messages: [{ role: 'user', content: [document()] }] });
  const wire = await res.text();
  if (status === 400) {
    assert.equal(res.status, 200, wire); assert.match(wire, /ROUTE_OK/);
    assert.equal(seen.externalPdf.length, 1);
    assert.equal(seen.route.filter(c => hasImages(c.body)).length, 1);
    assert.equal(hasImages(seen.route.at(-1).body), false);
    assert.ok(seen.route.every(c => c.body.model === 'local-alias'));
  } else {
    assert.equal(res.status, 502, wire); assert.equal(seen.externalPdf.length, 0); assert.equal(seen.vision.length, 0);
  }
  assert.equal(seen.base.length, 0);
});

test('V0.29.69 route capability=true overrides global false but never overrides the global passthrough gate', async t => {
  const enabled = await setup(t, { routes: { alias: { vision_enabled: true } }, extraConfig: { vllmBaseVisionEnabled: false } });
  assert.equal((await enabled.post({ messages: [{ role: 'user', content: [image()] }] })).status, 200);
  assert.ok(hasImages(enabled.seen.route.at(-1).body)); assert.equal(enabled.seen.vision.length, 0);
  const disabled = await setup(t, { routes: { alias: { vision_enabled: true } }, extraConfig: { visionNativePassthrough: false } });
  assert.equal((await disabled.post({ messages: [{ role: 'user', content: [image()] }] })).status, 200);
  assert.ok(!hasImages(disabled.seen.route.at(-1).body)); assert.equal(disabled.seen.vision.length, 1);
});

for (const protocol of ['anthropic', 'openai']) test(`V0.29.69 native PDF ${protocol} keeps the new SSE media timeline`, async t => {
  const { post } = await setup(t, { protocol });
  const res = await post({ stream: true, messages: [{ role: 'user', content: [document()] }] });
  const wire = await res.text(); assert.equal(res.status, 200, wire); assert.match(wire, /ROUTE_OK/); assert.match(wire, /message_stop/);
  assert.match(wire, /scan.pdf/); assert.doesNotMatch(wire, /模型處理中/);
  const events = wire.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  const text = events.filter(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta').map(e => e.delta.text).join('');
  assert.equal((text.match(/(?:Processing|處理中) · /g) || []).length, 1);
});

test('V0.29.69 plain count_tokens honors route, never generates or uses the Base alias', async t => {
  const { seen, post } = await setup(t);
  const res = await post({ messages: [{ role: 'user', content: 'hello' }] }, '/v1/messages/count_tokens');
  assert.equal(res.status, 200); assert.equal((await res.json()).input_tokens, 23);
  assert.equal(seen.base.length, 0); assert.equal(seen.route.length, 1); assert.equal(seen.route[0].body.model, 'local-alias');
});

test('V0.29.69 unmatched fallback count_tokens does not perform dedicated PDF inference', async t => {
  const { seen, post } = await setup(t);
  const res = await post({ model: 'unknown', messages: [{ role: 'user', content: [document()] }] }, '/v1/messages/count_tokens');
  assert.equal(res.status, 200, await res.text());
  assert.equal(seen.externalPdf.length, 0); assert.equal(seen.vision.length, 0);
});

test('V0.29.69 empty route API key never inherits client or Base credentials', async t => {
  const { seen, post } = await setup(t, { routes: { alias: { api_key: '' } } });
  assert.equal((await post({ messages: [{ role: 'user', content: compactPrompt }] })).status, 200);
  assert.equal(seen.route[0].headers.authorization, undefined); assert.equal(seen.route[0].headers['x-api-key'], undefined);
});

test('V0.29.69 native PDF never reuses dedicated PDF semantic cache on a later request', async t => {
  const { seen, post } = await setup(t, { routes: { native: {}, dedicated: { visual_use_route: false } } });
  let res = await post({ model: 'dedicated', messages: [{ role: 'user', content: [document()] }] });
  assert.equal(res.status, 200, await res.text()); const visionCalls = seen.externalPdf.length;
  assert.ok(visionCalls > 0);
  res = await post({ model: 'native', messages: [{ role: 'user', content: [document()] }] });
  assert.equal(res.status, 200, await res.text());
  assert.ok(hasImages(seen.route.at(-1).body)); assert.equal(seen.externalPdf.length, visionCalls);
  assert.doesNotMatch(JSON.stringify(seen.route.at(-1).body), /DEDICATED_PDF_VISION/);
});

for (const stream of [false, true]) test(`V0.29.69 unmatched compact keeps the legacy external priority then falls back through OpenAI adapter stream=${stream}`, async t => {
  const { seen, post } = await setup(t, { externalCompact: true });
  const res = await post({ model: 'unknown', stream, messages: [{ role: 'user', content: compactPrompt }] });
  const wire = await res.text(); assert.equal(res.status, 200, wire);
  assert.equal(seen.route.length, 0); assert.equal(seen.base.length, 1);
  assert.equal(seen.base[0].path, '/v1/chat/completions');
  assert.ok(seen.logs.some(e => e.event === 'context_compact_backend_fallback'));
  if (stream) assert.match(wire, /message_stop/);
  else assert.equal(JSON.parse(wire).type, 'message');
});

for (const protocol of ['anthropic', 'openai']) test(`V0.29.69 native PDF ${protocol} streaming capability fallback keeps one stream`, async t => {
  const { seen, post } = await setup(t, { protocol, rejectImage: 400 });
  const res = await post({ stream: true, messages: [{ role: 'user', content: [document()] }] });
  const wire = await res.text(); assert.equal(res.status, 200, wire);
  assert.match(wire, /ROUTE_OK/); assert.equal((wire.match(/event: message_start/g) || []).length, 1);
  assert.equal((wire.match(/event: message_stop/g) || []).length, 1);
  assert.equal(seen.route.filter(c => hasImages(c.body)).length, 1);
  assert.equal(seen.externalPdf.length, 1); assert.equal(seen.base.length, 0);
});

test('V0.29.69 two distinct vLLM endpoints/protocols preserve model and key during parallel PDF/compact', async t => {
  const otherCalls = [];
  const other = await serve(t, async (req, res) => {
    const body = await read(req); otherCalls.push({ body, headers: req.headers, path: req.url });
    await delay(12); answer(res, 'openai', body, 'OTHER_OK');
  });
  const { seen, post } = await setup(t, { routes: {
    a: {}, b: { url: other + '/v1', protocol: 'openai', model: 'other-model', api_key: 'other-key' },
  } });
  const jobs = [];
  for (const model of ['a', 'b']) for (const content of [[document()], compactPrompt]) {
    jobs.push(post({ model, messages: [{ role: 'user', content }] }).then(async res => { const wire = await res.text(); assert.equal(res.status, 200, wire); assert.match(wire, model === 'a' ? /ROUTE_OK/ : /OTHER_OK/); }));
  }
  await Promise.all(jobs);
  assert.equal(seen.base.length, 0); assert.equal(seen.route.length, 2); assert.equal(otherCalls.length, 2);
  assert.ok(seen.route.every(c => c.body.model === 'local-a' && c.headers.authorization === 'Bearer route-key'));
  assert.ok(otherCalls.every(c => c.body.model === 'other-model' && c.headers.authorization === 'Bearer other-key' && c.path === '/v1/chat/completions'));
  assert.equal(seen.externalPdf.length, 0); assert.equal(seen.vision.length, 0);
});

test('V0.29.69 rendered PDF request cannot exceed the configured request byte limit', async t => {
  const { seen, post, config } = await setup(t);
  config.limits = { ...config.limits, maxRequestBytes: 8192 };
  const res = await post({ messages: [{ role: 'user', content: [document()] }] });
  const wire = await res.text(); assert.equal(res.status, 413, wire);
  assert.match(wire, /pdf_native_request_limit/); assert.equal(seen.route.length, 0);
});
