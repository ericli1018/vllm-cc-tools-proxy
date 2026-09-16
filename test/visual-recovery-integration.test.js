import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { VisualRecoveryStore } from '../src/visual/visual-recovery-store.js';
import { createProxyServer } from '../src/services/proxy-server.js';

const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
const image = (buffer=png) => ({ type:'image', source:{type:'base64',media_type:'image/png',data:buffer.toString('base64')} });
const readTool = { name:'Read', description:'Read files and images from the client filesystem.', input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']} };
const sourceMessages = () => [
  {role:'user',content:'FULL_CONTEXT_307 inspect screenshot layout'},
  {role:'assistant',content:[{type:'tool_use',id:'original-read',name:'Read',input:{file_path:'/client/screen.png'}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'original-read',content:[image()]}]},
];
function eachBlock(value, fn) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) eachBlock(v,fn); return; }
  fn(value);
  for (const v of Object.values(value)) if (v && typeof v === 'object') eachBlock(v,fn);
}
function findManifest(payload) {
  let result;
  eachBlock(payload.messages, b => { if(b.type==='text' && b.text?.startsWith('[VCC_VISUAL_SOURCE')) result=b.text; });
  return result;
}
function perceptionFrom(request,{partial=false,answer='VISIBLE_LAYOUT',omit=[]}={}) {
  return {schema_version:'visual-perception-v1',status:partial?'partial':'complete',
    answers:request.questions.filter(q=>!omit.includes(q.id)).map(q=>({question_id:q.id,answer,confidence:0.95,source_ids:request.source_ids,support_refs:[`${request.source_ids[0]}:e1`]})),
    source_results:request.source_ids.map(source_id=>({source_id,evidence:[{evidence_id:'e1',kind:'text',observation:answer,confidence:0.95}],relationships:[],unresolved:partial?[{question_id:request.questions[0].id,reason_code:'small_text',detail:'Need a closer observation.',retryable:true}]:[]})),needs_followup:partial};
}
async function listen(s) { s.listen(0,'127.0.0.1'); await once(s,'listening'); return `http://127.0.0.1:${s.address().port}`; }
async function close(s) { s.closeAllConnections(); if(s.listening) await new Promise(r=>s.close(r)); }
async function read(req) { const out=[]; for await(const c of req) out.push(c); return Buffer.concat(out).toString(); }
async function harness(t,{decision='inspect',vision,main,rootDir,rejectNative=false,acceptNative=false}={}) {
  const cacheDir=rootDir || await fs.mkdtemp(path.join(os.tmpdir(),'vcc307-'));
  const trace=[]; const payloads=[]; const servers=[]; let visualCount=0; let clientCount=0;
  const base=http.createServer(async(req,res)=>{
    try {
      const body=JSON.parse(await read(req)); payloads.push(body);
      if(rejectNative&&JSON.stringify(body).includes(png.toString('base64'))){
        assert.equal(body.tools?.some(t=>['submit_visual_plan','resolve_visual_intent'].includes(t.name)),false,'internal planning must remain pixel-free');
        res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:'Model does not support image inputs'}}));return;
      }
      if(!acceptNative||body.tools?.some(t=>['submit_visual_plan','resolve_visual_intent'].includes(t.name)))assert.equal(JSON.stringify(body).includes(png.toString('base64')),false,'internal text Main must not receive image bytes');
      let content;
      const name=body.tools?.find(x=>['submit_visual_plan','resolve_visual_intent'].includes(x.name))?.name;
      if(name) {
        trace.push(name);
        assert.match(JSON.stringify(body.messages),/FULL_CONTEXT_307/,'internal planning must keep complete context');
        const tool=body.tools.find(x=>x.name===name);
        const ids=tool.input_schema?.properties?.source_ids?.items?.enum || ['img_01'];
        const wantsOCR=JSON.stringify(body.messages).includes('錯誤代碼');
        const selected=typeof decision==='function'?decision(body):decision;
        const input=name==='resolve_visual_intent'
          ? (typeof selected==='object'?{reason:'Based on current user request.',...selected,source_ids:selected.source_ids||ids}: {action:selected,source_ids:selected==='skip'?[]:ids.slice(0,1),reason:'Based on current user request.'})
          : {schema_version:'visual-query-plan-v1',source_ids:ids,objective:wantsOCR?'Read error code':'Inspect layout',questions:[{id:wantsOCR?'ocr':'layout',question:wantsOCR?'What error code is visible?':'Are controls overlapping?'}],requested_evidence:['text','layout'],detail_level:'high'};
        content=[{type:'tool_use',id:`internal-${payloads.length}`,name,input}];
      } else {
        trace.push('main');
        if(main) content=await main(body,++clientCount);
        if(!content) {
          if(JSON.stringify(body).includes('VCC_VISUAL_REACQUIRE_V1')) content=[{type:'tool_use',id:`client-read-${++clientCount}`,name:'Read',input:{file_path:'/client/screen.png'}}];
          else content=[{type:'text',text:JSON.stringify(body.messages).includes('VISIBLE_')?'MAIN_WITH_EVIDENCE':'MAIN_WITHOUT_EVIDENCE'}];
        }
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id:'mock-main',type:'message',role:'assistant',model:'text-main',content,stop_reason:content.some(x=>x.type==='tool_use')?'tool_use':'end_turn',usage:{input_tokens:32,output_tokens:16}}));
    } catch(error) {res.writeHead(500);res.end(JSON.stringify({error:String(error.stack)}));}
  }); servers.push(base); const baseUrl=await listen(base);
  async function proxy({native=false}={}) {
    const cfg={host:'127.0.0.1',port:0,resourceProfile:'default',limits:{maxRequestBytes:4194304,maxDecodedBytes:4194304,maxPdfPages:20,maxOutputChars:100000,processTimeoutMs:20000,maxImagePixels:20000000,maxVisualPagesPerBatch:4},vllmBaseUrl:baseUrl,vllmBaseApiKey:'',vllmBaseTimeouts:{connectTimeoutMs:10000,headersTimeoutMs:10000,bodyTimeoutMs:10000},vllmVisionUrl:'http://vision.invalid',vllmVisionModel:'vision',vllmVisionProvider:'vllm',visionOrchestrationMode:'directed',visionNativePassthrough:native,vllmBaseVisionEnabled:native,maxToolRounds:6,progressVisibleAfterMs:30000,progressPingIntervalMs:10000,progressHeartbeatMs:15000,concurrency:{visionLimit:1},logLevel:'error',gitRevision:'test',usagePreflightEnabled:false,responseLanguage:'en-US',cache:{rootDir:cacheDir,maxBytes:64*1024*1024,retentionMs:3600000}};
    const s=createProxyServer(cfg,{mediaAdapterDependencies:{normalizeImage:async b=>({buffer:b,mediaType:'image/png',width:600,height:180,originalWidth:600,originalHeight:180})},directedPerceptionDependencies:{analyzeVisualAssets:async(assets,opts)=>{
      visualCount++;trace.push('vision');
      assert.ok(assets.length>0,'normal perception must receive pixels');
      const match=opts.prompt.match(/PERCEPTION_REQUEST_JSON\n([^\n]+)/);
      const request=JSON.parse(match[1]);
      return {markdown:JSON.stringify(vision?vision(request,visualCount,opts):perceptionFrom(request,{answer:request.questions[0].id==='ocr'?'VISIBLE_ERROR_E42':'VISIBLE_LAYOUT'}))};
    }}});servers.push(s);const url=await listen(s);return {server:s,url};
  }
  const post=async(p,messages,{session='session307',tools=[readTool],stream=false,expectedStatus=200}={})=>{
    const r=await fetch(`${p.url}/v1/messages`,{method:'POST',headers:{'content-type':'application/json','x-claude-code-session-id':session},body:JSON.stringify({model:'m',stream,max_tokens:8192,tools,messages})});
    const text=await r.text();assert.equal(r.status,expectedStatus,text);return stream?text:JSON.parse(text);
  };
  t.after(async()=>{for(const s of servers)await close(s);await fs.rm(cacheDir,{recursive:true,force:true});});
  return {proxy,post,trace,payloads,cacheDir,get visionCalls(){return visualCount;}};
}
async function evictPixels(dir) {
  for(const ent of await fs.readdir(dir,{withFileTypes:true})) {
    const p=path.join(dir,ent.name);
    if(ent.isDirectory())await evictPixels(p);
    else if((await fs.readFile(p)).equals(png)) await fs.rm(p);
  }
}
const historyQuestion=q=>[...sourceMessages(),{role:'assistant',content:'Previous inspection finished.'},{role:'user',content:q}];

test('V0.30.7 restarted proxy analyzes historical raw image for current visual intent',async t=>{
  const h=await harness(t);const p=await h.proxy();
  const result=await h.post(p,historyQuestion('你看一下截圖上有沒有問題'));
  assert.equal(result.content[0].text,'MAIN_WITH_EVIDENCE');
  assert.equal(h.visionCalls,1);
  assert.ok(h.trace.indexOf('submit_visual_plan')<h.trace.indexOf('vision'));
});
test('V0.30.7 Main resolver skips unrelated historical images',async t=>{
  const h=await harness(t,{decision:'skip'});const p=await h.proxy();
  await h.post(p,historyQuestion('Explain JavaScript Array.map.'));
  assert.equal(h.visionCalls,0);
  assert.ok(h.trace.includes('resolve_visual_intent'),'semantic decision must reach Main');
  assert.equal(h.trace.includes('submit_visual_plan'),false);
});
test('V0.30.7 same image with new OCR question does not reuse layout-only evidence',async t=>{
  const h=await harness(t);const p=await h.proxy();await h.post(p,sourceMessages());
  const result=await h.post(p,historyQuestion('請讀出截圖裡的錯誤代碼。'));
  assert.equal(h.visionCalls,2);
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_ERROR_E42/);
  assert.equal(result.content[0].text,'MAIN_WITH_EVIDENCE');
});
test('V0.30.7 complete evidence can be explicitly reused for a related current request',async t=>{
  const h=await harness(t,{decision:'reuse'});const p=await h.proxy();await h.post(p,sourceMessages());
  await h.post(p,historyQuestion('依照剛才看到的排版結果列出修正項目。'));
  assert.equal(h.visionCalls,1);
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_LAYOUT/);
  assert.ok(h.trace.includes('resolve_visual_intent'));
});
test('V0.30.7 missing cache bytes returns a real frontend Read and resumes after restart',async t=>{
  const h=await harness(t);let p=await h.proxy();await h.post(p,sourceMessages());
  const manifest=findManifest(h.payloads.at(-1));assert.ok(manifest);
  await evictPixels(h.cacheDir);await close(p.server);p=await h.proxy();
  const old=sourceMessages();old[2].content[0].content=[{type:'text',text:manifest}];
  const msgs=[...old,{role:'assistant',content:'Previous inspection finished.'},{role:'user',content:'請讀出截圖裡的錯誤代碼。'}];
  const response=await h.post(p,msgs);
  assert.equal(response.stop_reason,'tool_use');
  const call=response.content.find(x=>x.type==='tool_use');assert.equal(call.name,'Read');assert.equal(call.input.file_path,'/client/screen.png');
  assert.equal(h.visionCalls,1,'cannot run Vision before frontend returns pixels');
  await close(p.server);p=await h.proxy();
  const result=await h.post(p,[...msgs,{role:'assistant',content:response.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:[image()]}]}]);
  assert.equal(result.content[0].text,'MAIN_WITH_EVIDENCE');
  assert.equal(h.visionCalls,2);
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_ERROR_E42/);
});
test('V0.30.7 manifest-only request can restore original pixels from persistent cache',async t=>{
  const h=await harness(t);let p=await h.proxy();await h.post(p,sourceMessages());const manifest=findManifest(h.payloads.at(-1));
  await close(p.server);p=await h.proxy();
  await h.post(p,[{role:'user',content:[{type:'text',text:`FULL_CONTEXT_307\n${manifest}`}]},{role:'assistant',content:'previous'},{role:'user',content:'請讀出錯誤代碼。'}]);
  assert.equal(h.visionCalls,2);
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_ERROR_E42/);
});
test('V0.30.7 partial evidence receives one targeted follow-up before returning to Main',async t=>{
  const h=await harness(t,{vision:(r,n)=>perceptionFrom(r,{partial:n===1,answer:n===1?'VISIBLE_PARTIAL':'VISIBLE_COMPLETE'})});const p=await h.proxy();
  const result=await h.post(p,sourceMessages());assert.equal(h.visionCalls,2);
  assert.equal(result.content[0].text,'MAIN_WITH_EVIDENCE');
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_COMPLETE/);
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_PARTIAL/,'useful initial evidence must be retained');
});
test('V0.30.7 unanswered requested questions are incomplete even when Sensor says complete',async t=>{
  const h=await harness(t,{vision:(r,n)=>perceptionFrom(r,{omit:n===1?[r.questions[0].id]:[]})});const p=await h.proxy();
  await h.post(p,sourceMessages());assert.equal(h.visionCalls,2);
});

async function missingHistory(h,p,question='請讀出截圖裡的錯誤代碼。',{capture=false}={}) {
  const initial=sourceMessages();
  if(capture)initial.splice(1,0,{role:'assistant',content:[{type:'tool_use',id:'original-capture',name:'browser_screenshot',input:{target:'page'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'original-capture',content:JSON.stringify({path:'/client/screen.png'})}]});
  await h.post(p,initial);
  const manifest=findManifest(h.payloads.at(-1));
  await evictPixels(h.cacheDir);
  const messages=structuredClone(initial);messages.at(-1).content[0].content=[{type:'text',text:manifest}];
  return [...messages,{role:'assistant',content:'Previous inspection finished.'},{role:'user',content:question}];
}
function continuation(messages,response,content,is_error=false){
  const call=response.content.find(x=>x.type==='tool_use');
  return [...messages,{role:'assistant',content:response.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content,is_error}]}];
}
const captureTool={name:'browser_screenshot',description:'Capture a browser screenshot.',input_schema:{type:'object',properties:{target:{type:'string'}},required:['target']}};
async function recoveries(h){const store=new VisualRecoveryStore({rootDir:h.cacheDir});return store.listRecoveries('session307');}

test('V0.30.7 screenshot path-only result requires Read, with one acquisition attempt across restart',async t=>{
  const h=await harness(t,{main:body=>{
    if(!JSON.stringify(body).includes('VCC_VISUAL_REACQUIRE_V1'))return;
    const pathOnly=JSON.stringify(body).includes('path_only_result');
    return [{type:'tool_use',id:pathOnly?'returned-path-read':'new-capture',name:pathOnly?'Read':'browser_screenshot',input:pathOnly?{file_path:'/client/new.png'}:{target:'page'}}];
  }});let p=await h.proxy();let msgs=await missingHistory(h,p,undefined,{capture:true});
  const first=await h.post(p,msgs,{tools:[captureTool,readTool]});
  assert.equal(first.content[0].name,'browser_screenshot');
  msgs=continuation(msgs,first,JSON.stringify({path:'/client/new.png'}));
  await close(p.server);p=await h.proxy();
  const second=await h.post(p,msgs,{tools:[captureTool,readTool]});
  assert.equal(second.content[0].name,'Read');assert.equal(second.content[0].input.file_path,'/client/new.png');
  assert.equal(h.visionCalls,1,'a path is not pixels');
  assert.equal((await recoveries(h))[0].attempts,1);
  await h.post(p,continuation(msgs,second,[image()]),{tools:[captureTool,readTool]});
  assert.equal(h.visionCalls,2);
});
test('V0.30.7 pending handoff replays the same tool_use without another Main call after restart',async t=>{
  const h=await harness(t);let p=await h.proxy();const msgs=await missingHistory(h,p);
  const response=await h.post(p,msgs);const calls=h.payloads.length;
  await close(p.server);p=await h.proxy();
  assert.deepEqual(await h.post(p,msgs),response);assert.equal(h.payloads.length,calls);
});
test('V0.30.7 missing source with no available frontend tool reports a specific unavailable source',async t=>{
  const h=await harness(t);const p=await h.proxy();const msgs=await missingHistory(h,p);
  const response=await h.post(p,msgs,{tools:[]});
  assert.equal(response.stop_reason,'end_turn');assert.equal(h.visionCalls,1);
  assert.match(JSON.stringify(h.payloads.at(-1)),/client_image_tool_unavailable/);
  assert.equal(response.content.some(x=>x.type==='tool_use'),false);
});
test('V0.30.7 repeated failed Read is bounded across restart and is not emitted again',async t=>{
  const h=await harness(t);let p=await h.proxy();const msgs=await missingHistory(h,p);
  const response=await h.post(p,msgs);
  await close(p.server);p=await h.proxy();
  const failure=await h.post(p,continuation(msgs,response,'File not found',true),{expectedStatus:422});
  assert.match(JSON.stringify(failure),/visual_reacquire_no_progress/);assert.equal(h.visionCalls,1);
});
test('V0.30.7 two different failed acquisition attempts stop before a third across restart',async t=>{
  const h=await harness(t,{main:body=>{
    if(!JSON.stringify(body).includes('VCC_VISUAL_REACQUIRE_V1'))return;
    const retried=JSON.stringify(body).includes('client_tool_error');
    return [{type:'tool_use',id:retried?'retry-capture':'first-read',name:retried?'browser_screenshot':'Read',input:retried?{target:'page'}:{file_path:'/client/screen.png'}}];
  }});let p=await h.proxy();let msgs=await missingHistory(h,p,undefined,{capture:true});
  const first=await h.post(p,msgs,{tools:[readTool,captureTool]});
  msgs=continuation(msgs,first,'File not found',true);
  const second=await h.post(p,msgs,{tools:[readTool,captureTool]});
  msgs=continuation(msgs,second,'Capture failed',true);
  await close(p.server);p=await h.proxy();
  const end=await h.post(p,msgs,{tools:[readTool,captureTool]});
  assert.equal(end.stop_reason,'end_turn');assert.equal((await recoveries(h))[0].attempts,2);assert.equal(h.visionCalls,1);
  assert.match(JSON.stringify(h.payloads.at(-1)),/visual_source_recovery_exhausted/);
});
test('V0.30.7 partial evidence follow-up budget survives a tool continuation and restart',async t=>{
  const h=await harness(t,{vision:r=>perceptionFrom(r,{partial:true,answer:'VISIBLE_PARTIAL'})});let p=await h.proxy();
  await h.post(p,sourceMessages());assert.equal(h.visionCalls,2);
  await close(p.server);p=await h.proxy();
  await h.post(p,[...sourceMessages(),{role:'assistant',content:[{type:'tool_use',name:'Read',id:'code-read',input:{file_path:'/client/app.js'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'code-read',content:'app source code'}]}]);
  assert.equal(h.visionCalls,2,'same task must retain partial evidence without an infinite follow-up loop');
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_PARTIAL/);
});
test('V0.30.7 a current screenshot request reacquires pixels even when old pixels are cached',async t=>{
  const h=await harness(t,{decision:{action:'inspect',temporal_scope:'current'}});const p=await h.proxy();await h.post(p,sourceMessages());
  const response=await h.post(p,historyQuestion('請看目前畫面是否仍有錯誤代碼。'));
  assert.equal(response.stop_reason,'tool_use');assert.equal(h.visionCalls,1);
});
test('V0.30.7 replacement pixels cannot answer a request for the missing original',async t=>{
  const h=await harness(t,{decision:{action:'inspect',temporal_scope:'original'}});let p=await h.proxy();const msgs=await missingHistory(h,p);
  const response=await h.post(p,msgs);
  await close(p.server);p=await h.proxy();
  await h.post(p,continuation(msgs,response,[image(Buffer.concat([png,Buffer.from('different image version')]))]));
  assert.equal(h.visionCalls,1);assert.match(JSON.stringify(h.payloads.at(-1)),/ORIGINAL image was replaced/);
});
test('V0.30.7 missing source handoff also completes the SSE stream with a client tool_use',async t=>{
  const h=await harness(t);const p=await h.proxy();const msgs=await missingHistory(h,p);
  const stream=await h.post(p,msgs,{stream:true});
  assert.match(stream,/"stop_reason":"tool_use"/);assert.match(stream,/"name":"Read"/);assert.match(stream,/event: message_stop/);
  assert.doesNotMatch(stream,/正在請模型規劃下一步/);assert.equal(h.visionCalls,1);
});
test('V0.30.7 a comparison keeps the other image when one missing original is reacquired',async t=>{
  const h=await harness(t,{decision:{action:'inspect'}});let p=await h.proxy();
  const secondPng=Buffer.concat([png,Buffer.from('second screenshot')]);
  const initial=[...sourceMessages(),{role:'assistant',content:[{type:'tool_use',id:'second-read',name:'Read',input:{file_path:'/client/other.png'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'second-read',content:[image(secondPng)]}]}];
  await h.post(p,initial);
  const manifests=[];eachBlock(h.payloads.at(-1).messages,b=>{if(b.type==='text'&&b.text?.startsWith('[VCC_VISUAL_SOURCE'))manifests.push(b.text);});
  const msgs=structuredClone(initial);msgs[2].content[0].content=[{type:'text',text:manifests[0]}];msgs[4].content[0].content=[{type:'text',text:manifests[1]}];
  msgs.push({role:'assistant',content:'previous'},{role:'user',content:'比較兩張截圖的錯誤代碼。'});
  await evictPixels(h.cacheDir);await close(p.server);p=await h.proxy();
  const response=await h.post(p,msgs);assert.equal(response.stop_reason,'tool_use');
  await h.post(p,continuation(msgs,response,[image()]));
  const lastPlan=h.payloads.filter(x=>x.tools?.some(t=>t.name==='submit_visual_plan')).at(-1);
  assert.equal(lastPlan.tools[0].input_schema.properties.source_ids.items.enum.length,2,'both comparison sources must reach the resumed plan');
});
test('V0.30.7 a failed client tool result cannot supply successful visual evidence',async t=>{
  const h=await harness(t);const p=await h.proxy();const msgs=await missingHistory(h,p);
  const response=await h.post(p,msgs);
  await h.post(p,continuation(msgs,response,[image()],true),{expectedStatus:422});
  assert.equal(h.visionCalls,1);
});
test('V0.30.7 replaying replacement pixels remains blocked for the original-image task',async t=>{
  const h=await harness(t,{decision:{action:'inspect',temporal_scope:'original'}});let p=await h.proxy();const msgs=await missingHistory(h,p);
  const response=await h.post(p,msgs);
  const changed=continuation(msgs,response,[image(Buffer.concat([png,Buffer.from('changed original')]))]);
  await h.post(p,changed);await close(p.server);p=await h.proxy();
  await h.post(p,changed);assert.equal(h.visionCalls,1);
});

test('V0.30.7 exact image request replay retains the completed follow-up budget across restart',async t=>{
  const h=await harness(t,{vision:r=>perceptionFrom(r,{partial:true,answer:'VISIBLE_PARTIAL'})});let p=await h.proxy();
  await h.post(p,sourceMessages());assert.equal(h.visionCalls,2);
  await close(p.server);p=await h.proxy();await h.post(p,sourceMessages());
  assert.equal(h.visionCalls,2);assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_PARTIAL/);
});
test('V0.30.7 discovered deferred screenshot tool reaches the frontend with its actual schema',async t=>{
  const h=await harness(t,{main:body=>{
    if(!JSON.stringify(body).includes('VCC_VISUAL_REACQUIRE_V1'))return;
    const discovered=body.tools?.some(x=>x.name==='browser_screenshot');
    return [{type:'tool_use',id:discovered?'discovered-capture':'discovery',name:discovered?'browser_screenshot':'tool_search_tool_regex',input:discovered?{target:'page'}:{pattern:'browser_screenshot'}}];
  }});const p=await h.proxy();await missingHistory(h,p,undefined,{capture:true});
  const manifest=findManifest(h.payloads.at(-1));
  const msgs=[{role:'user',content:`FULL_CONTEXT_307\n${manifest}`},{role:'assistant',content:'previous'},{role:'user',content:'請讀出錯誤代碼。'}];
  const tools=[{type:'tool_search_tool_regex_20251119',name:'tool_search_tool_regex'},{...captureTool,defer_loading:true}];
  const response=await h.post(p,msgs,{tools});assert.equal(response.content[0].name,'browser_screenshot');
  assert.equal((await recoveries(h))[0].attempts,1,'local discovery is not an acquisition attempt');
});
test('V0.30.7 native image rejection with durable history still falls back to directed perception',async t=>{
  const h=await harness(t,{rejectNative:true});let p=await h.proxy();await h.post(p,sourceMessages());
  await close(p.server);p=await h.proxy({native:true});
  const result=await h.post(p,historyQuestion('請讀出截圖裡的錯誤代碼。'));
  assert.equal(h.visionCalls,2);assert.equal(result.content[0].text,'MAIN_WITH_EVIDENCE');
  assert.match(JSON.stringify(h.payloads.at(-1).messages),/VISIBLE_ERROR_E42/);
});

for(const rejects of [false,true])test(`V0.30.7 mixed native and directed images retain perception when native ${rejects?'rejects':'accepts'}`,async t=>{
  const h=await harness(t,{acceptNative:true,rejectNative:rejects});const p=await h.proxy({native:true});
  const msgs=[{role:'user',content:[{type:'text',text:'FULL_CONTEXT_307 inspect both images'},image()]},{role:'assistant',content:[{type:'tool_use',id:'capture',name:'browser_screenshot',input:{target:'page'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'capture',content:[image(Buffer.concat([png,Buffer.from('second image')]))]}]}];
  const result=await h.post(p,msgs);
  assert.ok(h.visionCalls>=1,'non-native screenshot must reach Vision');
  assert.equal(result.content[0].text,'MAIN_WITH_EVIDENCE');
  const main=h.payloads.at(-1);assert.equal(JSON.stringify(main).includes(png.toString('base64')),!rejects,'native pixels stay on their original route only if accepted');
  if(rejects){const plan=h.payloads.filter(b=>b.tools?.some(t=>t.name==='submit_visual_plan')).at(-1);assert.equal(plan.tools[0].input_schema.properties.source_ids.items.enum.length,2,'newly adapted native source also needs observation');}
});
