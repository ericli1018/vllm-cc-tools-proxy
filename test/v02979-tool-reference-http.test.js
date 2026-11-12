import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const clientKey = 'front-end-only';
const backendKey = 'backend-only';
const toolName = 'mcp__comfyui__get_image';
const schema = { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] };
const definitions = [
  { name: 'ToolSearch', description: 'Search available tools.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: toolName, description: 'Get a ComfyUI image.', input_schema: schema, defer_loading: true },
];
const input = (model = 'alias', options = {}) => ({
  model, stream: false, max_tokens: 128,
  tools: definitions,
  messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_search_1', name: 'ToolSearch', input: { query: 'image' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_search_1', content: [
      { type: 'text', text: 'Found image tool' },
      { type: 'tool_reference', tool_name: toolName },
    ] }] },
  ], ...options,
});
const respond = (res, payload, status=200) => {
  res.writeHead(status, { 'content-type':'application/json' });
  res.end(JSON.stringify(payload));
};
async function listen(t, handler) {
  const server = handler instanceof http.Server ? handler : http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, { protocol='anthropic', routeMode='compat', logLevel='error' }={}) {
  const seen = [];
  const url = await listen(t, async (req,res) => {
    let raw=''; for await(const chunk of req) raw+=chunk;
    const body = JSON.parse(raw);
    seen.push({ body, headers:req.headers, path:req.url });
    if(protocol==='anthropic') return respond(res, {
      id:'msg_test',type:'message',role:'assistant',model:'real',content:[{type:'text',text:'OK'}],
      stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:20,output_tokens:1},
    });
    return respond(res, { id:'chat_test',object:'chat.completion',model:'real',choices:[{
      index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop',
    }],usage:{prompt_tokens:20,completion_tokens:1} });
  });
  
  const config={...loadConfig({
    VLLM_BASE_URL:url, VLLM_BASE_MODEL:'base-real', VLLM_BASE_API_PROTOCOL:'anthropic', VLLM_BASE_API_KEY:'base-secret',
    VLLM_MODEL_ROUTES:JSON.stringify({alias:{url,model:'real',protocol,api_key:backendKey,tool_reference_mode:routeMode}}),
    VLLM_MODEL_ROUTING_UNKNOWN_MODEL:'reject', PROXY_API_KEY:clientKey, PROXY_AUTH_ENABLED:'true',
    COMPLETION_PROBE_ENABLED:'false',PROXY_RUNTIME_TIME_ENABLED:'false',LOG_LEVEL:logLevel,
  }), usagePreflightEnabled:false, logSink:()=>{}  };
  const proxyUrl=await listen(t,createProxyServer(config));
  const send=(body,auth=clientKey) => fetch(proxyUrl+'/v1/messages',{
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify(body),
  });
  return { seen,send };
}
for(const protocol of ['anthropic','openai']) {
  test(`v0.29.79 HTTP ${protocol}: reference normalized, exact tool schema callable, backend credentials isolated`,async t=>{
    const {seen,send}=await fixture(t,{protocol});
    const result=await send(input());
    assert.equal(result.status,200,await result.text());
    assert.equal(seen.length,1);
    assert.equal(seen[0].headers.authorization,`Bearer ${backendKey}`);
    assert.equal(seen[0].headers['x-api-key'], protocol==='anthropic'?backendKey:undefined);
    const req=seen[0].body;
    assert.equal(req.model,'real');
    assert.equal(req.tools.find(x => x.name===toolName || x.function?.name===toolName)?.defer_loading, protocol==='anthropic' ? false : undefined);
    const visible=req.tools.find(x => x.name===toolName || x.function?.name===toolName);
    assert.deepEqual(visible.input_schema ?? visible.function?.parameters,schema);
    const text=JSON.stringify(req.messages);
    assert.doesNotMatch(text,/"type":"tool_reference"/);
    assert.match(text,/mcp__comfyui__get_image/);
    assert.match(text,/toolu_search_1/);
  });
}
test('v0.29.79 HTTP missing reference definition fails locally before contacting backend',async t=>{
  const {seen,send}=await fixture(t);
  const req=input(); req.tools=req.tools.slice(0,1);
  const res=await send(req);assert.equal(res.status,400);
  assert.match(await res.text(),/tool_reference_missing_definition/);
  assert.equal(seen.length,0);
});
test('v0.29.79 HTTP anonymous request fails before reference conversion and backend work',async t=>{
  const {seen,send}=await fixture(t);
  const res=await send(input(),'wrong-key');assert.equal(res.status,401);await res.text();assert.equal(seen.length,0);
});
test('v0.29.79 HTTP passthrough allowed only on native Anthropic route',async t=>{
  const {seen,send}=await fixture(t,{routeMode:'passthrough',protocol:'anthropic'});
  const res=await send(input());assert.equal(res.status,200);await res.text();
  assert.ok(JSON.stringify(seen[0].body).includes('"type":"tool_reference"'));
});
test('v0.29.79 HTTP passthrough cannot send unresolved references to OpenAI',async t=>{
  const {seen,send}=await fixture(t,{routeMode:'passthrough',protocol:'openai'});
  const res=await send(input());assert.equal(res.status,400);
  assert.match(await res.text(),/tool_reference_passthrough_openai/);
  assert.equal(seen.length,0);
});
