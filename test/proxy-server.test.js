import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createProxyServer } from '../src/services/proxy-server.js';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function startJsonServer(handler) { const server = http.createServer(handler); const url = await listen(server); return { server, url }; }
async function read(req) { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function config(overrides = {}) {
  return {
    host: '127.0.0.1', port: 0, resourceProfile: 'default',
    limits: { maxRequestBytes: 4*1024*1024, maxDecodedBytes: 4*1024*1024, maxPdfPages: 20, maxOutputChars: 100000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20_000_000, maxVisualPagesPerBatch: 4 },
    vllmBaseApiKey: '', vllmBaseTimeouts: { connectTimeoutMs: 10000, headersTimeoutMs: 900000, bodyTimeoutMs: 900000 }, vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
    searxngUrl: '', webFetchUrl: '', webFetchApiKey: '', maxToolRounds: 6,
    progressVisibleAfterMs: 0, progressPingIntervalMs: 10000, progressHeartbeatMs: 15000,
    concurrency: { profile: 'default', managedLimit: 2, queueLimit: 12, queueTimeoutMs: 120000, visionLimit: 1 },
    logLevel: 'error', gitRevision: 'test', ...overrides,
  };
}

test('proxy health endpoint reports V0.2.12, admission and cache state', async (t) => {
  const server = createProxyServer(config({ vllmBaseUrl: 'http://127.0.0.1:9' }));
  const url = await listen(server); t.after(() => server.close());
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok', service: 'proxy', version: '0.2.12', revision: 'test',
    managed: { active: 0, limit: 2, queued: 0, queue_limit: 12 },
    vision: { active: 0, limit: 1 },
    cache: { entries: 0, bytes: 0, max_bytes: 0, limit_mode: 'filesystem', write_available: true, inflight_analyses: 0 },
  });
});

test('HEAD root is handled locally as Claude Code startup probe', async (t) => {
  const server = createProxyServer(config({ vllmBaseUrl: 'http://127.0.0.1:9' }));
  const url = await listen(server); t.after(() => server.close());
  const response = await fetch(`${url}/`, { method: 'HEAD' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

test('Claude Code hello probes are handled locally without contacting base vLLM', async (t) => {
  const server = createProxyServer(config({ vllmBaseUrl: 'http://127.0.0.1:9' }));
  const url = await listen(server); t.after(() => server.close());

  const head = await fetch(`${url}/api/hello`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const get = await fetch(`${url}/api/hello/`);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { message: 'hello' });
});

test('unknown endpoints bypass transparently to base vLLM', async (t) => {
  const upstream = await startJsonServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/models?limit=1000');
    res.writeHead(206, { 'content-type': 'application/json', 'x-vllm': 'yes' });
    res.end(JSON.stringify({ data: ['m'] }));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url, vllmBaseApiKey: 'base-key' }));
  const proxyUrl = await listen(proxy); t.after(() => upstream.server.close()); t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/models?limit=1000`);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('x-vllm'), 'yes');
  assert.deepEqual(await response.json(), { data: ['m'] });
});

test('plain non-stream Messages request bypasses with original raw JSON bytes', async (t) => {
  const original = Buffer.from('{"model":"m", "stream":false, "messages":[{"role":"user","content":"hi"}]}\n');
  let observed;
  const upstream = await startJsonServer(async (req, res) => {
    observed = await read(req);
    res.writeHead(201, { 'content-type': 'application/json', 'x-vllm': 'raw' });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url }));
  const proxyUrl = await listen(proxy); t.after(() => upstream.server.close()); t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: original });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-vllm'), 'raw');
  assert.deepEqual(observed, original);
});

test('non-stream PDF is locally parsed and raw Base64 never reaches base vLLM', async (t) => {
  const pdf = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const upstreamBodies = [];
  const vllm = await startJsonServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer base-key');
    const payload = JSON.parse((await read(req)).toString()); upstreamBodies.push(payload);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id:'msg-1',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'done'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1} }));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: vllm.url, vllmBaseApiKey: 'base-key' }));
  const proxyUrl = await listen(proxy); t.after(() => vllm.server.close()); t.after(() => proxy.close());
  const base64 = pdf.toString('base64');
  const response = await fetch(`${proxyUrl}/v1/messages/`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ model:'m',stream:false,messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}}]}] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'done');
  const serialized = JSON.stringify(upstreamBodies[0]);
  assert.match(serialized, /Native PDF text page/);
  assert.equal(serialized.includes(base64), false);
});

test('historical PDF is analyzed once then served from cache without a second progress block', async (t) => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-proxy-cache-'));
  t.after(() => fs.rm(cacheRoot, { recursive: true, force: true }));
  const pdf = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const base64 = pdf.toString('base64');
  let parses = 0;
  let upstreamCalls = 0;
  const vllm = http.createServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    upstreamCalls += 1;
    assert.match(JSON.stringify(payload), /CACHED PDF MARKDOWN/);
    assert.equal(JSON.stringify(payload).includes(base64), false);
    if (payload.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"SECOND"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id:'first',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'FIRST'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1} }));
    }
  });
  const vllmUrl = await listen(vllm);
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllmUrl,
    cache: { rootDir: cacheRoot, maxBytes: 0, retentionMs: 60_000, pipelineVersion: 'media-v3', visualPromptVersion: 'visual-v2' },
  }), {
    mediaAdapterDependencies: {
      parsePdf: async () => {
        parses += 1;
        return { parser:'test',page_count:1,processed_pages:1,visual_used:false,markdown:'CACHED PDF MARKDOWN',warnings:[],truncated:false };
      },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => vllm.close()); t.after(() => proxy.close());
  const messages = [{ role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}}] }];

  const first = await fetch(`${proxyUrl}/v1/messages`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({model:'m',stream:false,messages}) });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).content[0].text, 'FIRST');
  const cacheFiles = (await fs.readdir(cacheRoot)).filter((name) => name.endsWith('.json'));
  assert.equal(cacheFiles.length, 1);
  const cacheText = await fs.readFile(path.join(cacheRoot, cacheFiles[0]), 'utf8');
  assert.equal(cacheText.includes(base64), false);
  assert.match(cacheText, /CACHED PDF MARKDOWN/);

  const second = await fetch(`${proxyUrl}/v1/messages`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({model:'m',stream:true,messages:[...messages,{role:'assistant',content:[{type:'text',text:'FIRST'}]},{role:'user',content:'write it'}]}) });
  const stream = await second.text();
  assert.match(stream, /SECOND/);
  assert.doesNotMatch(stream, /VLLM-CC-TOOLS-PROXY 進度/);
  assert.equal(parses, 1);
  assert.equal(upstreamCalls, 2);
});

test('streamed managed request emits progress and final Anthropic blocks', async (t) => {
  const searx = await startJsonServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({results:[{title:'x',url:'https://example.com',content:'y'}]}));});
  let call=0;
  const vllm=await startJsonServer(async(req,res)=>{const payload=JSON.parse((await read(req)).toString());assert.equal(payload.stream,false);call+=1;const response=call===1?{id:'a',type:'message',role:'assistant',model:'m',content:[{type:'tool_use',id:'tool-1',name:'WebSearch',input:{query:'abc'}}],stop_reason:'tool_use',usage:{input_tokens:1,output_tokens:1}}:{id:'b',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'FINAL'}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:3}};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));});
  const proxy=createProxyServer(config({vllmBaseUrl:vllm.url,searxngUrl:searx.url,progressVisibleAfterMs:60_000}));const proxyUrl=await listen(proxy);t.after(()=>searx.server.close());t.after(()=>vllm.server.close());t.after(()=>proxy.close());
  const response=await fetch(`${proxyUrl}/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,tools:[{name:'WebSearch',description:'search',input_schema:{type:'object'}}],messages:[{role:'user',content:'search'}]})});
  const text=await response.text();assert.match(text,/目前處理進度/);assert.match(text,/正在搜尋/);assert.match(text,/FINAL/);assert.match(text,/event: message_stop/);assert.doesNotMatch(text,/VLLMCCP:v1:/);assert.equal(call,2);
});

test('plain bypass strips the dedicated progress block before forwarding history to base vLLM', async (t) => {
  let observed;
  const upstream = await startJsonServer(async (req, res) => {
    observed = JSON.parse((await read(req)).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url }));
  const proxyUrl = await listen(proxy); t.after(() => upstream.server.close()); t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [
          { type: 'text', text: 'VLLM-CC-TOOLS-PROXY 進度：\n正在解析 PDF…\n處理完成；正在回傳模型結果…' },
          { type: 'text', text: '真正答案' },
        ] },
        { role: 'user', content: 'continue' },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(observed.messages[1].content, [{ type: 'text', text: '真正答案' }]);
});

test('ordinary streaming request passes upstream SSE through', async (t) => {
  const vllm=http.createServer(async(req,res)=>{const payload=JSON.parse((await read(req)).toString());assert.equal(payload.stream,true);res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');});
  const vllmUrl=await listen(vllm);const proxy=createProxyServer(config({vllmBaseUrl:vllmUrl}));const proxyUrl=await listen(proxy);t.after(()=>vllm.close());t.after(()=>proxy.close());
  const response=await fetch(`${proxyUrl}/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,messages:[{role:'user',content:'hi'}]})});
  const text=await response.text();assert.match(text,/message_start/);assert.match(text,/message_stop/);
});

test('streamed media request preprocesses under managed slot then streams base vLLM SSE', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const vision = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    assert.equal(payload.model, 'vision-model');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'IMAGE ANALYSIS' } }] }));
  });
  const vllm = http.createServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    assert.equal(payload.stream, true);
    assert.match(JSON.stringify(payload), /IMAGE ANALYSIS/);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    setTimeout(() => {
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"LIVE"}}\n\n');
      res.end('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    }, 10);
  });
  const vllmUrl = await listen(vllm);
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllmUrl,
    vllmVisionUrl: vision.url,
    vllmVisionModel: 'vision-model',
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => vision.server.close()); t.after(() => vllm.close()); t.after(() => proxy.close());
  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] }] }),
  });
  const text = await response.text();
  assert.match(text, /正在使用視覺模型分析圖片/);
  assert.match(text, /LIVE/);
  assert.equal((text.match(/event: message_start/g) || []).length, 1);
  assert.equal((text.match(/event: message_stop/g) || []).length, 1);
  assert.match(text, /"index":1/);
});

test('managed queue is bounded and exposed through health', async (t) => {
  let releaseFirstSearch;
  let firstSearchStartedResolve;
  const firstSearchStarted = new Promise((resolve) => { firstSearchStartedResolve = resolve; });
  let searchCalls = 0;
  const searx = await startJsonServer(async (_req, res) => {
    searchCalls += 1;
    if (searchCalls === 1) {
      firstSearchStartedResolve();
      await new Promise((resolve) => { releaseFirstSearch = resolve; });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const vllm = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    const hasResult = payload.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'));
    const body = hasResult
      ? { id: 'done', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: 'tool', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `tool-${Math.random()}`, name: 'WebSearch', input: { query: 'q' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllm.url, searxngUrl: searx.url,
    concurrency: { profile: 'test', managedLimit: 1, queueLimit: 1, queueTimeoutMs: 5000, visionLimit: 1 },
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => searx.server.close()); t.after(() => vllm.server.close()); t.after(() => proxy.close());
  const request = () => fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: false, tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'search' }] }) });
  const a = request();
  await firstSearchStarted;
  const b = request();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const health = await (await fetch(`${proxyUrl}/health`)).json();
  assert.equal(health.managed.active, 1);
  assert.equal(health.managed.queued, 1);
  const c = await request();
  assert.equal(c.status, 429);
  assert.equal((await c.json()).error.type, 'proxy_queue_full');
  releaseFirstSearch();
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
});

test('managed queue timeout returns 503 without starting queued work', async (t) => {
  let releaseSearch;
  let searchStartedResolve;
  const searchStarted = new Promise((resolve) => { searchStartedResolve = resolve; });
  let searchCalls = 0;
  const searx = await startJsonServer(async (_req, res) => {
    searchCalls += 1;
    if (searchCalls === 1) {
      searchStartedResolve();
      await new Promise((resolve) => { releaseSearch = resolve; });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const vllm = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    const hasResult = payload.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hasResult
      ? { id: 'done', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} }
      : { id: 'tool', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'tool', name: 'WebSearch', input: { query: 'q' } }], stop_reason: 'tool_use', usage: {} }));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllm.url, searxngUrl: searx.url,
    concurrency: { profile: 'test', managedLimit: 1, queueLimit: 1, queueTimeoutMs: 30, visionLimit: 1 },
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => searx.server.close()); t.after(() => vllm.server.close()); t.after(() => proxy.close());
  const body = JSON.stringify({ model: 'm', stream: false, tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'search' }] });
  const first = fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  await searchStarted;
  const second = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(second.status, 503);
  assert.equal(second.headers.get('retry-after'), '10');
  assert.equal((await second.json()).error.type, 'proxy_queue_timeout');
  assert.equal(searchCalls, 1);
  releaseSearch();
  assert.equal((await first).status, 200);
});

test('queued streaming request reports position and starts after admission', async (t) => {
  let releaseSearch;
  let searchStartedResolve;
  const searchStarted = new Promise((resolve) => { searchStartedResolve = resolve; });
  let searchCalls = 0;
  const searx = await startJsonServer(async (_req, res) => {
    searchCalls += 1;
    if (searchCalls === 1) {
      searchStartedResolve();
      await new Promise((resolve) => { releaseSearch = resolve; });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const vllm = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    const hasResult = payload.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hasResult
      ? { id: 'done', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} }
      : { id: 'tool', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `tool-${searchCalls}`, name: 'WebSearch', input: { query: 'q' } }], stop_reason: 'tool_use', usage: {} }));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllm.url, searxngUrl: searx.url,
    concurrency: { profile: 'test', managedLimit: 1, queueLimit: 2, queueTimeoutMs: 1000, visionLimit: 1 },
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => searx.server.close()); t.after(() => vllm.server.close()); t.after(() => proxy.close());
  const makeBody = (stream) => JSON.stringify({ model: 'm', stream, tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'search' }] });
  const first = fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: makeBody(false) });
  await searchStarted;
  const secondResponse = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: makeBody(true) });
  assert.equal(secondResponse.status, 200);
  releaseSearch();
  assert.equal((await first).status, 200);
  const streamText = await secondResponse.text();
  assert.match(streamText, /任務正在排隊/);
  assert.match(streamText, /任務已開始處理/);
  assert.match(streamText, /event: message_stop/);
});

test('client cancellation removes a queued request', async (t) => {
  let releaseSearch;
  let searchStartedResolve;
  const searchStarted = new Promise((resolve) => { searchStartedResolve = resolve; });
  const searx = await startJsonServer(async (_req, res) => {
    searchStartedResolve();
    await new Promise((resolve) => { releaseSearch = resolve; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const vllm = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    const hasResult = payload.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hasResult
      ? { id: 'done', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: {} }
      : { id: 'tool', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'tool', name: 'WebSearch', input: { query: 'q' } }], stop_reason: 'tool_use', usage: {} }));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllm.url, searxngUrl: searx.url,
    concurrency: { profile: 'test', managedLimit: 1, queueLimit: 2, queueTimeoutMs: 1000, visionLimit: 1 },
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => searx.server.close()); t.after(() => vllm.server.close()); t.after(() => proxy.close());
  const body = JSON.stringify({ model: 'm', stream: false, tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'search' }] });
  const first = fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  await searchStarted;
  const controller = new AbortController();
  const second = fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(second, (error) => error.name === 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const health = await (await fetch(`${proxyUrl}/health`)).json();
  assert.equal(health.managed.queued, 0);
  releaseSearch();
  await first;
});

test('quick managed stream does not show a progress block only to announce completion', async (t) => {
  const vllm = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    assert.equal(payload.stream, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'quick', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'text', text: 'QUICK_FINAL' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllm.url,
    searxngUrl: 'http://127.0.0.1:9',
    progressVisibleAfterMs: 1,
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => vllm.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true,
      tools: [{ name: 'WebSearch', description: 'search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'answer without searching' }],
    }),
  });
  const stream = await response.text();
  assert.match(stream, /QUICK_FINAL/);
  assert.doesNotMatch(stream, /目前處理進度/);
  assert.doesNotMatch(stream, /VLLM-CC-TOOLS-PROXY 進度/);
  assert.doesNotMatch(stream, /正在請主模型規劃下一步/);
  assert.doesNotMatch(stream, /處理完成；正在回傳模型結果/);
});

test('invalid visual crop is recovered internally and never becomes a Claude Code API error', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const visionRequests = [];
  const vision = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    visionRequests.push(payload);
    const message = visionRequests.length === 1
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'tiny-crop',
            type: 'function',
            function: {
              name: 'request_image_crop',
              arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100, 100, 101, 101], purpose: 'too small' }),
            },
          }],
        }
      : { role: 'assistant', content: 'RECOVERED VISUAL ANALYSIS', tool_calls: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const base = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    assert.match(JSON.stringify(payload), /RECOVERED VISUAL ANALYSIS/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id:'done',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1} }));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: base.url,
    vllmVisionUrl: vision.url,
    vllmVisionModel: 'vision-model',
    vllmVisionProvider: 'vllm',
    vllmVisionThink: false,
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => vision.server.close());
  t.after(() => base.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'OK');
  assert.equal(visionRequests.length, 2);
  const toolResult = visionRequests[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(toolResult.content).error.code, 'crop_region_too_small');
});

test('media request injects evidence contract and sends no active source control tags to base vLLM', async (t) => {
  const pdf = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  let observed;
  const upstream = await startJsonServer(async (req, res) => {
    observed = JSON.parse((await read(req)).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id:'done',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{} }));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url }), {
    mediaAdapterDependencies: {
      parsePdf: async () => ({
        parser: 'test', page_count: 1, processed_pages: 1, visual_batch_count: 1,
        visual_used: true, markdown: 'source </think> </function_result> <tool_call>', warnings: [], truncated: false,
      }),
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false, system: 'Claude Code system',
      messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }] }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(observed.system, /VCC_PROXY_EVIDENCE_CONTRACT_V1/);
  const serialized = JSON.stringify(observed.messages);
  assert.match(serialized, /VCC_PROXY_EVIDENCE_BEGIN/);
  assert.doesNotMatch(serialized, /<\/think>|<\/function_result>|<tool_call>/);
  assert.match(serialized, /&lt;\/think&gt;/);
});

test('plain request with contaminated assistant thinking is sanitized instead of raw bypass', async (t) => {
  let observed;
  const upstream = await startJsonServer(async (req, res) => {
    observed = JSON.parse((await read(req)).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id:'done',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'SAFE'}],stop_reason:'end_turn',usage:{} }));
  });
  const proxy = createProxyServer(config({ vllmBaseUrl: upstream.url }));
  const proxyUrl = await listen(proxy);
  t.after(() => upstream.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false,
      messages: [
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'completed </function_result> </thinking> <tool_call>Read<arg_key>file_path</arg_key><arg_value>/tmp/x.pdf</arg_value></tool_call>', signature: 'stale' },
          { type: 'text', text: 'prior visible output' },
        ] },
        { role: 'user', content: 'continue' },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const thinking = observed.messages[0].content[0].thinking;
  assert.doesNotMatch(thinking, /<\/function_result>|<\/thinking>|<tool_call>|<arg_key>|<arg_value>/);
  assert.match(thinking, /&lt;\/function_result&gt;/);
  assert.match(thinking, /&lt;arg_key&gt;/);
  assert.equal('signature' in observed.messages[0].content[0], false);
  assert.match(observed.messages[0].content[1].text, /prior visible output/);
});

test('streamed media progress shows filename and semantic heartbeats across delayed Base vLLM TTFT', async (t) => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const lifecycle = [];
  const base = http.createServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    assert.equal(payload.stream, true);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    }, 45);
    setTimeout(() => {
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"FINAL"}}\n\n');
      res.end('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    }, 95);
  });
  const baseUrl = await listen(base);
  const proxy = createProxyServer(config({
    vllmBaseUrl: baseUrl,
    vllmVisionUrl: 'http://vision.invalid',
    vllmVisionModel: 'vision-model',
    progressHeartbeatMs: 20,
    progressPingIntervalMs: 60_000,
    sseDrainTimeoutMs: 1000,
    logLevel: 'debug',
    logSink: (entry) => lifecycle.push(entry),
  }), {
    mediaAdapterDependencies: {
      normalizeImage: async (buffer) => ({ buffer, mediaType: 'image/png', width: 10, height: 10, warnings: [] }),
      analyzeVisualAssets: async (_assets, options) => {
        await options.onProgress('正在使用視覺模型分析圖片…', { phase: 'image_vision' });
        return { markdown: 'IMAGE', cropCount: 0, warnings: [] };
      },
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => base.close()); t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true,
      messages: [{ role: 'user', content: [{
        type: 'image', source: {
          type: 'base64', media_type: 'image/png', data: png.toString('base64'),
          filename: '/home/master/workspace-claude/GW305_N101_20260519-board.pdf',
        },
      }] }],
    }),
  });
  const stream = await response.text();
  assert.match(stream, /檔案：GW305_N101_20260519-board\.pdf/);
  assert.match(stream, /圖片 1\/1/);
  assert.match(stream, /主模型仍在處理中/);
  assert.match(stream, /FINAL/);
  assert.doesNotMatch(stream, /\/home\/master\/workspace-claude/);
  for (const event of ['base_upstream_request_start', 'base_upstream_headers_received', 'base_upstream_first_event', 'base_upstream_stream_completed']) {
    assert.ok(lifecycle.some((entry) => entry.event === event), `missing ${event}`);
  }
  assert.ok(lifecycle.some((entry) => entry.event === 'managed_task_progress' && entry.delivery_status === 'requested'));
  assert.ok(lifecycle.some((entry) => entry.event === 'progress_sse_sent' && entry.kind === 'semantic_heartbeat'));
});

test('managed Base request uses configured response-header timeout and returns a stage-specific error', async (t) => {
  const vllm = http.createServer((_req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'late', type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'text', text: 'too late' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    }, 80);
  });
  const vllmUrl = await listen(vllm);
  const logs = [];
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllmUrl,
    vllmBaseTimeouts: { connectTimeoutMs: 200, headersTimeoutMs: 25, bodyTimeoutMs: 200 },
    logLevel: 'info',
    logSink: (entry) => logs.push(entry),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => vllm.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true,
      tools: [{ name: 'WebSearch', description: 'search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'search current news' }],
    }),
  });
  const stream = await response.text();
  assert.match(stream, /vllm_headers_timeout/);
  assert.doesNotMatch(stream, /too late/);
  const failed = logs.find((entry) => entry.event === 'base_upstream_request_failed');
  assert.equal(failed.stage, 'headers');
  assert.equal(failed.code, 'vllm_headers_timeout');
  assert.equal(failed.timeout_ms, 25);
});

test('Base lifecycle state changes are delivered immediately instead of waiting for heartbeat', async (t) => {
  const pdf = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const logs = [];
  const vllm = http.createServer(async (req, res) => {
    await read(req);
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => {
        if (res.destroyed) return;
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"DONE"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, 25);
    }, 25);
  });
  const vllmUrl = await listen(vllm);
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllmUrl,
    progressHeartbeatMs: 60_000,
    logLevel: 'info',
    logSink: (entry) => logs.push(entry),
  }), {
    mediaAdapterDependencies: {
      parsePdf: async () => ({
        parser: 'test', page_count: 1, processed_pages: 1, visual_used: false,
        markdown: 'PDF evidence', warnings: [], truncated: false,
      }),
    },
  });
  const proxyUrl = await listen(proxy);
  t.after(() => vllm.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true,
      messages: [{ role: 'user', content: [{
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', filename: '/secret/path/board.pdf', data: pdf.toString('base64') },
      }] }],
    }),
  });
  const stream = await response.text();
  const requestStart = stream.indexOf('正在將內容送往主模型');
  const headersReceived = stream.indexOf('主模型已接受請求');
  const firstEvent = stream.indexOf('主模型已開始回傳結果');
  assert.ok(requestStart >= 0);
  assert.ok(headersReceived > requestStart);
  assert.ok(firstEvent > headersReceived);
  assert.match(stream, /DONE/);

  const sent = logs.filter((entry) => entry.event === 'progress_sse_sent');
  assert.ok(sent.some((entry) => entry.phase === 'base_request_start' && entry.delivery_latency_ms < 25));
  assert.ok(sent.some((entry) => entry.phase === 'base_headers_received' && entry.delivery_latency_ms < 25));
  assert.ok(logs.some((entry) => entry.event === 'progress_state_changed' && entry.phase === 'base_headers_received'));
});


test('managed request logs protocol provenance and repairs malformed final output without leaking tags', async (t) => {
  const logs = [];
  let call = 0;
  const vllm = await startJsonServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    call += 1;
    let body;
    if (call === 1) {
      body = { id:'a',type:'message',role:'assistant',model:'m',content:[{type:'tool_use',id:'s1',name:'WebSearch',input:{query:'news'}}],stop_reason:'tool_use',usage:{} };
    } else if (call === 2) {
      body = { id:'b',type:'message',role:'assistant',model:'m',content:[{type:'thinking',thinking:'done </function_results> final in thinking'}],stop_reason:'end_turn',usage:{} };
    } else {
      assert.equal('tools' in payload, false);
      body = { id:'c',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'SAFE_FINAL'}],stop_reason:'end_turn',usage:{} };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const searx = await startJsonServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllm.url,
    searxngUrl: searx.url,
    logLevel: 'debug',
    logSink: (entry) => logs.push(entry),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => vllm.server.close());
  t.after(() => searx.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: true,
      system: 'Claude dialect </function_results>',
      tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'news' }],
    }),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /SAFE_FINAL/);
  assert.doesNotMatch(stream, /<\/function_results>|final in thinking/);
  const incoming = logs.find((entry) => entry.event === 'incoming_protocol_inventory');
  assert.equal(incoming.tag_count, 1);
  assert.deepEqual(incoming.tag_counts, { function_results: 1 });
  assert.equal(incoming.system_tag_count, 1);
  assert.deepEqual(incoming.system_tag_counts, { function_results: 1 });
  assert.equal(incoming.message_tag_count, 0);
  assert.deepEqual(incoming.message_tag_counts, {});
  assert.ok(logs.some((entry) => entry.event === 'managed_final_response_repair_success'));
  assert.equal(JSON.stringify(logs).includes('Claude dialect'), false);
  assert.equal(JSON.stringify(logs).includes('final in thinking'), false);
});

test('managed WebFetch processes raw page content before sending readable evidence to the Base model', async (t) => {
  const logs = [];
  let processorPayload;
  let secondBasePayload;
  let baseCalls = 0;

  const fetchBackend = await startJsonServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      page_content: 'NAVIGATION JUNK\n\nSource fact 42',
      metadata: {
        final_url: 'https://example.com/final',
        title: 'Example article',
        content_type: 'text/html',
        status_code: 200,
        browser_rendered: true,
      },
    }]));
  });

  const vllm = http.createServer(async (req, res) => {
    const payload = JSON.parse((await read(req)).toString());
    if (req.url === '/v1/chat/completions') {
      processorPayload = payload;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Verified summary: fact 42.' } }] }));
      return;
    }
    assert.equal(req.url, '/v1/messages');
    baseCalls += 1;
    if (baseCalls === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'tool', type: 'message', role: 'assistant', model: 'main-model',
        content: [{
          type: 'tool_use', id: 'fetch-1', name: 'WebFetch',
          input: { url: 'https://example.com/article', prompt: 'Extract the verified number.' },
        }],
        stop_reason: 'tool_use', usage: {},
      }));
      return;
    }
    secondBasePayload = payload;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'done', type: 'message', role: 'assistant', model: 'main-model',
      content: [{ type: 'text', text: 'FINAL 42' }], stop_reason: 'end_turn', usage: {},
    }));
  });
  const vllmUrl = await listen(vllm);
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllmUrl,
    webFetchUrl: fetchBackend.url,
    webFetchProcessor: {
      enabled: true,
      url: `${vllmUrl}/v1/chat/completions`,
      model: '',
      apiKey: 'processor-secret',
      think: false,
    },
    logLevel: 'info',
    logSink: (entry) => logs.push(entry),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => fetchBackend.server.close());
  t.after(() => vllm.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'main-model', stream: false,
      tools: [{ name: 'WebFetch', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'Read the page.' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'FINAL 42');
  assert.equal(processorPayload.model, 'main-model');
  assert.equal(processorPayload.chat_template_kwargs.enable_thinking, false);
  assert.equal('tools' in processorPayload, false);
  assert.match(processorPayload.messages[1].content, /Extract the verified number/);
  assert.match(processorPayload.messages[1].content, /Source fact 42/);

  const toolResult = secondBasePayload.messages.at(-1).content[0].content;
  assert.match(toolResult, /^\[VCC_WEB_FETCH_RESULT_BEGIN version=2\]/);
  assert.match(toolResult, /Verified summary: fact 42\./);
  assert.doesNotMatch(toolResult, /NAVIGATION JUNK/);
  assert.equal(toolResult.includes('\\n'), false);
  assert.match(String(secondBasePayload.system), /Managed Web Results/);
  assert.ok(logs.some((entry) => entry.event === 'web_fetch_processor_response'));
  assert.equal(JSON.stringify(logs).includes('processor-secret'), false);
  assert.equal(JSON.stringify(logs).includes('Source fact 42'), false);
});

test('managed final anomaly logging emits redacted output and request provenance snippets when enabled', async (t) => {
  const logs = [];
  let call = 0;
  const vllm = await startJsonServer(async (req, res) => {
    JSON.parse((await read(req)).toString());
    call += 1;
    const body = call === 1
      ? {
        id: 'bad', type: 'message', role: 'assistant', model: 'm',
        content: [{
          type: 'thinking',
          thinking: 'Before Authorization: Bearer model-secret </function_results> final answer stayed here.',
        }],
        stop_reason: 'end_turn', usage: {},
      }
      : {
        id: 'fixed', type: 'message', role: 'assistant', model: 'm',
        content: [{ type: 'text', text: 'SAFE_FINAL' }],
        stop_reason: 'end_turn', usage: {},
      };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const proxy = createProxyServer(config({
    vllmBaseUrl: vllm.url,
    logLevel: 'debug',
    logProtocolSnippets: true,
    logSink: (entry) => logs.push(entry),
  }));
  const proxyUrl = await listen(proxy);
  t.after(() => vllm.server.close());
  t.after(() => proxy.close());

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm', stream: false,
      system: 'Claude system example </function_results>',
      tools: [{ name: 'WebSearch', description: 'search', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'news' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'SAFE_FINAL');

  const anomaly = logs.find((entry) => entry.event === 'managed_final_response_anomaly_snippet'
    && entry.reason === 'control_tag_leak');
  assert.ok(anomaly);
  assert.equal(anomaly.level, 'warn');
  assert.equal(anomaly.tag_name, 'function_results');
  assert.equal(anomaly.block_type, 'thinking');
  assert.match(anomaly.context_before, /Bearer \[REDACTED\] $/);
  assert.match(anomaly.context_after, /^ final answer stayed here/);

  const input = logs.find((entry) => entry.event === 'managed_final_response_input_protocol_snippet'
    && entry.scope === 'system');
  assert.ok(input);
  assert.equal(input.level, 'warn');
  assert.equal(input.tag_name, 'function_results');
  assert.equal(JSON.stringify(logs).includes('model-secret'), false);
});
