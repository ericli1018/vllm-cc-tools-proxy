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
    logLevel: 'error', gitRevision: 'test', ...overrides,
  };
}

test('proxy health endpoint reports V0.2', async (t) => {
  const server = createProxyServer(config({ vllmBaseUrl: 'http://127.0.0.1:9' }));
  const url = await listen(server); t.after(() => server.close());
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'proxy', version: '0.2.1', revision: 'test' });
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
  const response = await fetch(`${proxyUrl}/v1/messages`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ model:'m',stream:false,messages:[{role:'user',content:[{type:'document',source:{type:'base64',media_type:'application/pdf',data:base64}}]}] }) });
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
