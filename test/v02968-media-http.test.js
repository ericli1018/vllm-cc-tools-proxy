import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer } from '../src/services/proxy-server.js';

const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
const pdf = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); };
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const response = content => ({ id: 'test-final', type: 'message', role: 'assistant', model: 'local', content, stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } });
const image = (filename = '/private/input.png', buffer = png) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64'), filename } });
const document = () => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64'), filename: '/private/board.pdf' } });

async function serve(t, handler) {
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => {
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
function inspectWire(wire) {
  const events = wire.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const blocks = new Map();
  for (const e of events) {
    if (e.type === 'content_block_start') blocks.set(e.index, { type: e.content_block.type, text: e.content_block.text || '' });
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') blocks.get(e.index).text += e.delta.text;
  }
  return { events, blocks: [...blocks.values()], progress: [...blocks.values()].filter(b => /(?:處理中|Processing) · /.test(b.text)) };
}
function assertInline(wire) {
  const parsed = inspectWire(wire);
  assert.equal(parsed.progress.length, 1, 'one media + model progress block');
  const text = parsed.progress[0].text.replace(/\n\n$/, '');
  assert.equal((text.match(/處理中 · /g) || []).length, 1);
  assert.doesNotMatch(text, /模型處理中|\n|狀態：|\/private\//);
  assert.ok(parsed.events.some(e => e.type === 'message_stop'));
  assert.ok(parsed.blocks.some(b => b.text === 'FINAL_OK'));
  return text;
}

async function setup(t, { protocol = 'anthropic', directed = false, native = false, visionStatus = 'complete', visionError = false, planningError = false, realPdf = false, jsonBackend = false, gate = 0 } = {}) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'media-progress-68-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const seen = { base: [], vision: [], logs: [], analysis: 0 };
  const visionUrl = await serve(t, async (req, res) => {
    seen.vision.push(await read(req));
    await delay(15);
    if (visionError) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}'); return; }
    const answered = visionStatus === 'complete';
    json(res, { choices: [{ message: { content: JSON.stringify({ schema: 'visual_perception_v1', asset_id: 'visual-1', status: visionStatus,
      answers: [{ question_id: 'q1', status: answered ? 'answered' : 'unresolved', answer: answered ? 'Visible' : null, evidence: [], uncertainty: answered ? '' : 'small text' }], follow_up_regions: [] }) } }] });
  });
  const baseUrl = await serve(t, async (req, res) => {
    const body = await read(req); seen.base.push({ path: req.url, body });
    if (req.url.endsWith('/count_tokens')) { json(res, { input_tokens: 12 }); return; }
    if (body.tools?.some(tool => tool.name === 'SubmitVisualPlan')) {
      await delay(15);
      const content = planningError ? [{ type: 'text', text: 'invalid planning' }] : [{ type: 'tool_use', id: 'plan', name: 'SubmitVisualPlan', input: { objective: 'Inspect', questions: [{ id: 'q1', question: 'What is visible?' }] } }];
      json(res, { ...response(content), stop_reason: 'tool_use' }); return;
    }
    if (body.stream !== true || jsonBackend) {
      if (protocol === 'openai') json(res, { id: 'chat-final', model: 'local', choices: [{ message: { role: 'assistant', content: 'FINAL_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
      else json(res, response([{ type: 'text', text: 'FINAL_OK' }]));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    await delay(20);
    if (protocol === 'openai') {
      res.end(`data: ${JSON.stringify({ id: 'chat-final', model: 'local', choices: [{ index: 0, delta: { content: 'FINAL_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      res.write(event('message_start', { message: { ...response([]), stop_reason: null } }));
      res.write(event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
      res.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'FINAL_OK' } }));
      res.write(event('content_block_stop', { index: 0 }));
      res.write(event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }));
      res.end(event('message_stop', {}));
    }
  });
  const config = {
    host: '127.0.0.1', port: 0, resourceProfile: 'default', responseLanguage: 'zh-TW', logLevel: 'info', logSink: entry => seen.logs.push(entry),
    limits: { maxRequestBytes: 4*1024*1024, maxDecodedBytes: 4*1024*1024, maxPdfPages: 20, maxOutputChars: 100000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20_000_000, maxVisualPagesPerBatch: 4 },
    vllmBaseUrl: baseUrl, vllmBaseApiProtocol: protocol, vllmBaseModel: 'local', vllmBaseApiKey: '', vllmBaseTimeouts: { connectTimeoutMs: 3000, headersTimeoutMs: 3000, bodyTimeoutMs: 3000 },
    vllmVisionUrl: visionUrl, vllmVisionModel: 'vision', vllmVisionApiKey: '', vllmVisionProvider: 'vllm', vllmVisionTimeoutMs: 3000,
    vllmBaseVisionEnabled: native, visionNativePassthrough: native, visionOrchestrationMode: directed ? 'directed' : 'legacy',
    usagePreflightEnabled: false, completionProbeEnabled: false, maxToolRounds: 4, progressVisibleAfterMs: gate, progressPingIntervalMs: 10, progressHeartbeatMs: 10,
    concurrency: { visionLimit: 1 }, cache: { rootDir: cacheRoot, maxBytes: 0, retentionMs: 60000, pipelineVersion: 'media-v8', visualPromptVersion: 'visual-v18', evidenceContractVersion: 'evidence-v14' },
  };
  const proxy = createProxyServer(config, { mediaAdapterDependencies: {
    normalizeImage: async buffer => ({ buffer, mediaType: 'image/png', width: 100, height: 100, warnings: [] }),
    analyzeVisualAssets: async () => { seen.analysis++; await delay(15); return { markdown: 'IMAGE_EVIDENCE', warnings: [], cropCount: 0 }; },
    ...(!realPdf ? { parsePdf: async (_buffer, options) => {
      for (const details of [{ phase: 'pdf_metadata', total: 3, completed: 0 }, { phase: 'pdf_classify', total: 3, completed: 1 }, { phase: 'pdf_visual_batch', batch: 1, batches: 2 }, { phase: 'pdf_complete', total: 3, completed: 3 }]) {
        await options.onProgress('old detailed PDF message', details); await delay(5);
      }
      return { parser: 'test', page_count: 3, processed_pages: 3, visual_used: true, visual_batch_count: 2, markdown: 'PDF_EVIDENCE', warnings: [], truncated: false };
    } } : {}),
  } });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const url = `http://127.0.0.1:${proxy.address().port}`;
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const post = (messages, { streaming = true, subagent = false } = {}) => fetch(`${url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(subagent ? { 'x-claude-code-agent-id': 'child-68' } : {}) },
    body: JSON.stringify({ model: 'alias', stream: streaming, max_tokens: 128, messages }),
  });
  return { post, seen };
}

for (const protocol of ['anthropic', 'openai']) {
  test(`V0.29.68 HTTP ${protocol}: image preprocessing and main SSE use one timeline`, async t => {
    const { post, seen } = await setup(t, { protocol });
    const res = await post([{ role: 'user', content: [image()] }]);
    assert.equal(res.status, 200);
    const text = assertInline(await res.text());
    assert.match(text, /input\.png.*視覺判讀/);
    assert.match(text, /媒體就緒/);
    assert.equal(seen.analysis, 1);
    assert.ok(seen.logs.some(e => e.event === 'progress_sse_sent' && e.kind === 'semantic_heartbeat'));
  });
}

test('V0.29.68 HTTP PDF: actual parse stages and page/batch indices share the model timeline', async t => {
  const { post } = await setup(t);
  const text = assertInline(await (await post([{ role: 'user', content: [document()] }])).text());
  assert.match(text, /board\.pdf/);
  assert.match(text, /抽字.*頁 0\/3/);
  assert.match(text, /分類.*頁 1\/3/);
  assert.match(text, /批次 1\/2/);
  assert.doesNotMatch(text, /old detailed PDF message|%/);
});

test('V0.29.68 HTTP PDF: real Poppler text extraction emits the new progress format', async t => {
  const { post } = await setup(t, { realPdf: true });
  const text = assertInline(await (await post([{ role: 'user', content: [document()] }])).text());
  assert.match(text, /board\.pdf.*抽字.*合併/);
});

test('V0.29.68 HTTP Read(PDF) pages identify PDF provenance rather than ordinary image labels', async t => {
  const { post } = await setup(t);
  const page = image(); delete page.source.filename;
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-pdf', name: 'Read', input: { file_path: '/private/manual.pdf', pages: '6' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-pdf', content: [page] }] },
  ];
  const text = assertInline(await (await post(messages)).text());
  assert.match(text, /manual\.pdf.*PDF 頁面圖 1\/1.*頁 6/);
});

for (const status of ['complete', 'partial', 'unreadable', 'error']) {
  test(`V0.29.68 HTTP directed ${status}: planning and perception are visible without exposing prompts`, async t => {
    const { post, seen } = await setup(t, { directed: true, visionStatus: status === 'error' ? 'complete' : status, visionError: status === 'error' });
    const text = assertInline(await (await post([{ role: 'user', content: [image()] }])).text());
    assert.match(text, /規劃判讀.*等待視覺.*視覺判讀/);
    assert.match(text, status === 'complete' ? /判讀完成/ : status === 'partial' ? /⚠.*部分可讀/ : status === 'unreadable' ? /⚠.*無法辨識/ : /⚠.*判讀失敗/);
    assert.doesNotMatch(text, /SubmitVisualPlan|What is visible|PROXY_VISUAL|\/private/);
    assert.equal(seen.vision.length, 1);
    assert.equal(seen.base.length, 2, 'progress must not introduce extra model calls');
    if (status !== 'complete') assert.doesNotMatch(text, /判讀完成/);
  });
}

test('V0.29.68 HTTP native passthrough never invents external visual analysis', async t => {
  const { post, seen } = await setup(t, { native: true, directed: true });
  const wire = await (await post([{ role: 'user', content: [image()] }])).text();
  assert.match(wire, /FINAL_OK/);
  assert.doesNotMatch(wire, /規劃判讀|視覺判讀|媒體準備|模型處理中/);
  assert.equal(seen.vision.length, 0);
  assert.equal(seen.analysis, 0);
  assert.equal(seen.base.length, 1);
});

test('V0.29.68 HTTP directed subagent remains ping-only while the final answer is intact', async t => {
  const { post } = await setup(t, { directed: true });
  const wire = await (await post([{ role: 'user', content: [image()] }], { subagent: true })).text();
  const parsed = inspectWire(wire);
  assert.equal(parsed.progress.length, 0);
  assert.ok(parsed.events.some(e => e.type === 'ping'));
  assert.deepEqual(parsed.blocks.filter(b => b.type === 'text').map(b => b.text), ['FINAL_OK']);
});

test('V0.29.68 HTTP quick media request does not bypass the configured 30 second gate', async t => {
  const { post } = await setup(t, { directed: true, gate: 30000 });
  const parsed = inspectWire(await (await post([{ role: 'user', content: [image()] }])).text());
  assert.equal(parsed.progress.length, 0);
  assert.deepEqual(parsed.blocks.filter(b => b.type === 'text').map(b => b.text), ['FINAL_OK']);
});

for (const protocol of ['anthropic', 'openai']) {
  test(`V0.29.68 HTTP ${protocol}: non-streaming media still returns only normal JSON`, async t => {
    const { post } = await setup(t, { protocol });
    const res = await post([{ role: 'user', content: [document()] }], { streaming: false });
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.deepEqual(body.content, [{ type: 'text', text: 'FINAL_OK' }]);
  });
}

test('V0.29.68 HTTP streaming client also handles a buffered JSON backend without old progress', async t => {
  const { post } = await setup(t, { jsonBackend: true });
  assertInline(await (await post([{ role: 'user', content: [image()] }])).text());
});

test('V0.29.68 HTTP directed planning failure shows a warning, not a false successful final', async t => {
  const { post, seen } = await setup(t, { directed: true, planningError: true });
  const wire = await (await post([{ role: 'user', content: [image()] }])).text();
  const parsed = inspectWire(wire);
  assert.equal(parsed.progress.length, 1);
  assert.match(parsed.progress[0].text, /⚠.*判讀失敗/);
  assert.doesNotMatch(wire, /FINAL_OK|event: message_stop/);
  assert.equal(seen.vision.length, 0);
});

test('V0.29.68 HTTP concurrent directed requests keep file context and subagent visibility isolated', async t => {
  const { post, seen } = await setup(t, { directed: true });
  const inputs = [
    { filename: '/private/main-a.png', subagent: false },
    { filename: '/private/main-b.png', subagent: false },
    { filename: '/private/child-only.png', subagent: true },
  ];
  const wires = await Promise.all(inputs.map(async (input, index) => {
    const source = image(input.filename, Buffer.concat([png, Buffer.from([index + 1])]));
    return (await post([{ role: 'user', content: [source] }], { subagent: input.subagent })).text();
  }));
  for (let index = 0; index < 2; index++) {
    const text = assertInline(wires[index]);
    assert.ok(text.includes(path.basename(inputs[index].filename)));
    assert.match(text, /規劃判讀.*等待視覺.*視覺判讀.*判讀完成/);
    for (let other = 0; other < inputs.length; other++) {
      if (other !== index) assert.ok(!text.includes(path.basename(inputs[other].filename)));
    }
  }
  const child = inspectWire(wires[2]);
  assert.equal(child.progress.length, 0);
  assert.ok(child.events.some(e => e.type === 'ping'));
  assert.deepEqual(child.blocks.filter(b => b.type === 'text').map(b => b.text), ['FINAL_OK']);
  assert.equal(seen.vision.length, 3);
  assert.equal(seen.base.length, 6, 'only one planning call and one final call per request');
});

test('V0.29.68 HTTP cached media does not re-analyze or revert to the old progress header', async t => {
  const { post, seen } = await setup(t);
  const messages = [{ role: 'user', content: [image('/private/cached.png')] }];
  await (await post(messages)).text();
  const text = assertInline(await (await post(messages)).text());
  assert.doesNotMatch(text, /媒體準備|視覺判讀|規劃判讀/);
  assert.equal(seen.analysis, 1);
  assert.ok(seen.logs.some(entry => entry.event === 'route_decision' && entry.decision === 'cached_transform'));
  assert.equal(seen.base.length, 2);
});
