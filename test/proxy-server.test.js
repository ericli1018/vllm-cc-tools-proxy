import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer } from '../src/services/proxy-server.js';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function startJsonServer(handler) { const server = http.createServer(handler); const url = await listen(server); return { server, url }; }
async function read(req) { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function config(overrides = {}) {
  return {
    host: '127.0.0.1', port: 0, resourceProfile: 'default',
    limits: { maxRequestBytes: 4*1024*1024, maxDecodedBytes: 4*1024*1024, maxPdfPages: 20, maxOutputChars: 100000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20_000_000, maxVisualPagesPerBatch: 4 },
    vllmBaseApiKey: '', vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
    searxngUrl: '', webFetchUrl: '', maxToolRounds: 6,
    progressVisibleAfterMs: 0, progressPingIntervalMs: 10000, progressHeartbeatMs: 15000,
    concurrency: { profile: 'default', managedLimit: 2, queueLimit: 12, queueTimeoutMs: 120000, visionLimit: 1 },
    logLevel: 'error', gitRevision: 'test', ...overrides,
  };
}

test('proxy health endpoint reports V0.2.2 and admission state', async (t) => {
  const server = createProxyServer(config({ vllmBaseUrl: 'http://127.0.0.1:9' }));
  const url = await listen(server); t.after(() => server.close());
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok', service: 'proxy', version: '0.2.2', revision: 'test',
    managed: { active: 0, limit: 2, queued: 0, queue_limit: 12 },
    vision: { active: 0, limit: 1 },
  });
});

test('HEAD root is handled locally as Claude Code startup probe', async (t) => {
  const server = createProxyServer(config({ vllmBaseUrl: 'http://127.0.0.1:9' }));
  const url = await listen(server); t.after(() => server.close());
  const response = await fetch(`${url}/`, { method: 'HEAD' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
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

test('streamed managed request emits progress and final Anthropic blocks', async (t) => {
  const searx = await startJsonServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({results:[{title:'x',url:'https://example.com',content:'y'}]}));});
  let call=0;
  const vllm=await startJsonServer(async(req,res)=>{const payload=JSON.parse((await read(req)).toString());assert.equal(payload.stream,false);call+=1;const response=call===1?{id:'a',type:'message',role:'assistant',model:'m',content:[{type:'tool_use',id:'tool-1',name:'WebSearch',input:{query:'abc'}}],stop_reason:'tool_use',usage:{input_tokens:1,output_tokens:1}}:{id:'b',type:'message',role:'assistant',model:'m',content:[{type:'text',text:'FINAL'}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:3}};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));});
  const proxy=createProxyServer(config({vllmBaseUrl:vllm.url,searxngUrl:searx.url}));const proxyUrl=await listen(proxy);t.after(()=>searx.server.close());t.after(()=>vllm.server.close());t.after(()=>proxy.close());
  const response=await fetch(`${proxyUrl}/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,tools:[{name:'WebSearch',description:'search',input_schema:{type:'object'}}],messages:[{role:'user',content:'search'}]})});
  const text=await response.text();assert.match(text,/正在搜尋/);assert.match(text,/FINAL/);assert.match(text,/event: message_stop/);assert.equal(call,2);
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
