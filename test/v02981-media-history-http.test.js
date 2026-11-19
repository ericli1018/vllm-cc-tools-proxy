import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const image = label => ({ type:'image', source:{ type:'base64', media_type:'image/png', data:Buffer.concat([PNG,Buffer.from(label)]).toString('base64') } });
function history() {
  const messages=[{role:'user',content:[{type:'text',text:'pasted image'},image('pathless')]}];
  for(let index=1;index<=6;index++) messages.push(
    {role:'assistant',content:[{type:'tool_use',id:`r${index}`,name:'Read',input:{file_path:`/work/${index}.png`}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:`r${index}`,content:[{type:'text',text:`image ${index}`},image(String(index))]}]},
  );
  return messages;
}
async function listen(t,server){server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));return `http://127.0.0.1:${server.address().port}`;}
function scan(value, result={images:0,markers:[]}){
  if(!value||typeof value!=='object')return result;
  if(Array.isArray(value)){for(const x of value)scan(x,result);return result;}
  if(value.type==='image'||value.type==='image_url')result.images++;
  if(typeof value.text==='string'&&value.text.startsWith('[Image released:'))result.markers.push(value.text);
  if(typeof value.content==='string')for(const m of value.content.matchAll(/\[Image released: media_id=m_[0-9a-f]{32}; path=[^\]]+\]/g))result.markers.push(m[0]);
  for(const item of Object.values(value))scan(item,result);return result;
}
async function setup(t,{protocol='anthropic',enabled='true',max='4',trace=false}={}){
  const seen=[],vision=[],logs=[],traces=[];
  const upstream=await listen(t,http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};seen.push({path:req.url,body,headers:req.headers});
    res.setHeader('content-type','application/json');
    if(req.url.endsWith('/count_tokens'))return res.end(JSON.stringify({input_tokens:123}));
    if(req.url.endsWith('/tokenize'))return res.end(JSON.stringify({count:123,tokens:[]}));
    if(req.url.endsWith('/chat/completions'))return res.end(JSON.stringify({id:'c',model:body.model,choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:123,completion_tokens:1}}));
    return res.end(JSON.stringify({id:'m',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:123,output_tokens:1}}));
  }));
  const visionUrl=await listen(t,http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;vision.push({path:req.url,raw});res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'vision'}}]}));}));
  const config={...loadConfig({
    VLLM_BASE_URL:upstream+'/v1',VLLM_BASE_API_PROTOCOL:protocol,VLLM_BASE_MODEL:'physical',VLLM_BASE_API_KEY:'backend',
    VLLM_BASE_VISION_ENABLED:'true',VISION_NATIVE_PASSTHROUGH:'true',VISION_ORCHESTRATION_MODE:'directed',
    VLLM_VISION_URL:visionUrl,VLLM_VISION_MODEL:'vision',
    MEDIA_HISTORY_NORMALIZATION_ENABLED:enabled,MEDIA_HISTORY_MAX_PATH_IMAGES:max,
    COMPLETION_PROBE_ENABLED:'false',PROXY_RUNTIME_TIME_ENABLED:'false',MODEL_RESPONSE_LANGUAGE:'en-US',LOG_LEVEL:'info',
    DIAGNOSTIC_WEB_TOOL_TRACE:trace?'true':'false',
  }),cache:{rootDir:'',maxBytes:0},usagePreflightEnabled:false,logSink:e=>logs.push(e)};
  const dependencies=trace?{webToolDiagnosticTraceStore:{write:async entry=>{traces.push(structuredClone(entry));return {file_path:'/virtual/trace.json'};}}}:{};
  const proxy=await listen(t,createProxyServer(config,dependencies));
  const post=(path,body)=>fetch(proxy+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return {seen,vision,logs,traces,post,config};
}
function request(){return {model:'alias',max_tokens:32,stream:false,messages:history()};}

for(const protocol of ['anthropic','openai']) test(`V0.29.81 ${protocol} inference and count_tokens share the same normalized media history`,async t=>{
  const f=await setup(t,{protocol});
  const inference=await f.post('/v1/messages',request());const inferenceWire=await inference.text();assert.equal(inference.status,200,inferenceWire);
  const count=await f.post('/v1/messages/count_tokens',{...request(),max_tokens:undefined});const countWire=await count.text();assert.equal(count.status,200,countWire);assert.equal(JSON.parse(countWire).input_tokens,123);
  const inferCall=f.seen.find(x=>x.path.endsWith(protocol==='openai'?'/chat/completions':'/messages'));
  const countCall=f.seen.find(x=>x.path.endsWith(protocol==='openai'?'/tokenize':'/count_tokens'));
  assert.ok(inferCall);assert.ok(countCall);
  const a=scan(inferCall.body),b=scan(countCall.body);
  assert.equal(a.images,5);assert.equal(b.images,5);
  assert.equal(a.markers.length,2);assert.deepEqual(a.markers,b.markers);
  assert.match(a.markers[0],/path=\/work\/1\.png\]$/);assert.match(a.markers[1],/path=\/work\/2\.png\]$/);
  assert.equal(f.vision.length,0,'released and retained native images must not call dedicated Vision');
  const normalized=f.logs.filter(x=>x.event==='media_history_normalized');assert.equal(normalized.length,2);
  assert.ok(normalized.every(x=>x.released_path_images===2&&x.retained_path_images===4&&x.pathless_images===1));
  assert.doesNotMatch(JSON.stringify(normalized),/\/work\/|base64|media_id/);
});

test('V0.29.81 disabled normalization preserves every image and emits no normalization event',async t=>{
  const f=await setup(t,{enabled:'false'});const r=await f.post('/v1/messages',request());assert.equal(r.status,200);await r.text();
  const call=f.seen.find(x=>x.path.endsWith('/messages'));const found=scan(call.body);
  assert.equal(found.images,7);assert.equal(found.markers.length,0);assert.equal(f.logs.some(x=>x.event==='media_history_normalized'),false);
});

test('V0.29.81 max zero releases all PATH-backed images while preserving pathless user image',async t=>{
  const f=await setup(t,{max:'0'});const r=await f.post('/v1/messages',request());assert.equal(r.status,200);await r.text();
  const found=scan(f.seen.find(x=>x.path.endsWith('/messages')).body);
  assert.equal(found.images,1);assert.equal(found.markers.length,6);assert.equal(f.vision.length,0);
});

test('V0.29.81 normalization occurs before media inventory so released images do not appear as active media',async t=>{
  const f=await setup(t);const r=await f.post('/v1/messages',{...request(),stream:true});assert.equal(r.status,200);await r.text();
  const native=f.logs.find(x=>x.event==='native_vision_route_selected');assert.ok(native);assert.equal(native.eligible_image_count,5);
  assert.deepEqual([...new Set(native.source_kinds)].sort(),['direct_image','read_image']);
});


test('V0.29.81 normalization precedes optional diagnostic trace so released image bytes are not persisted there',async t=>{
  const f=await setup(t,{trace:true});const req=request();const oldOne=req.messages[2].content[0].content[1].source.data;const oldTwo=req.messages[4].content[0].content[1].source.data;
  const r=await f.post('/v1/messages',req);assert.equal(r.status,200);await r.text();
  const client=f.traces.find(x=>x.event==='client_request');assert.ok(client);
  const found=scan(client.payload.body);assert.equal(found.images,5);assert.equal(found.markers.length,2);
  const serialized=JSON.stringify(client);assert.doesNotMatch(serialized,new RegExp(oldOne));assert.doesNotMatch(serialized,new RegExp(oldTwo));
});
