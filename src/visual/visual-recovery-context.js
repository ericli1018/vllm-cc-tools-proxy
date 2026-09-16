import crypto from 'node:crypto';

export const RESOLVER_MARKER = 'VCC_PROXY_VISUAL_RESOLVER_V1';
export const REACQUIRE_MARKER = 'VCC_VISUAL_REACQUIRE_V1';
export const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export function appendVisualSystem(body, instruction) {
  const next=structuredClone(body);
  next.system=typeof next.system==='string' ? `${next.system}\n\n${instruction}` : [...(Array.isArray(next.system)?next.system:[]),{type:'text',text:instruction}];
  return next;
}
function humanText(content) {
  const text=typeof content==='string'?content:(Array.isArray(content)?content.filter(b=>b?.type==='text').map(b=>String(b.text||'')).join('\n'):'');
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,'').replace(/\[VCC_VISUAL_SOURCE[^\]]*\][\s\S]*?\[VCC_VISUAL_SOURCE_END\]/g,'').trim();
}
export function collectVisualContext(messages=[]) {
  const tools=new Map(), results=new Map(), references=[];
  const scan=(blocks,index,role,parentId='')=>{
    if(typeof blocks==='string') blocks=[{type:'text',text:blocks}];
    if(!Array.isArray(blocks))return;
    for(const b of blocks){
      if(b?.type==='tool_use' && b.id)tools.set(b.id,{toolName:String(b.name||''),input:structuredClone(b.input||{}),toolUseId:b.id,messageIndex:index});
      if(b?.type==='tool_result' && b.tool_use_id)results.set(b.tool_use_id,{block:b,messageIndex:index});
      if(role==='user' && b?.type==='text'){
        const pattern=/\[VCC_VISUAL_SOURCE[^\]]*\]\s*(\{[^\n]*\})\s*\[VCC_VISUAL_SOURCE_END\]/g;
        for(const match of String(b.text||'').matchAll(pattern)){
          try{const manifest=JSON.parse(match[1]);if(typeof manifest.source_id==='string' && references.length<64)references.push({manifest,text:match[0],messageIndex:index,toolUseId:parentId});}catch{}
        }
      }
      if(b?.type==='tool_result')scan(b.content,index,role,b.tool_use_id);
    }
  };
  messages.forEach((m,i)=>scan(m?.content,i,m?.role));
  let intent='';for(let i=messages.length-1;i>=0;i--){if(messages[i]?.role==='user' && (intent=humanText(messages[i].content)))break;}
  const current=messages.at(-1);
  return {tools,results,references,intent,intentKey:digest(intent.replace(/\s+/g,' ').toLowerCase()),currentIndex:messages.length-1,newHuman:current?.role==='user' && Boolean(humanText(current.content))};
}
export function hasVisualManifest(messages) {return collectVisualContext(messages).references.length>0;}
export function originalLocator(context,provenance={}) {
  const call=context.tools.get(provenance.toolUseId);
  if(!call)return null;
  const locator={toolName:call.toolName,input:structuredClone(call.input),toolUseId:call.toolUseId};
  if(call.toolName.toLowerCase()==='read') {
    const pathname=String(call.input.file_path||call.input.path||call.input.filename||'');
    const capture=[...context.tools.values()].reverse().find(t=>t.messageIndex<call.messageIndex && /screenshot|capture/i.test(t.toolName) && JSON.stringify(context.results.get(t.toolUseId)?.block?.content||'').includes(pathname) && pathname);
    if(capture)locator.alternative={toolName:capture.toolName,input:structuredClone(capture.input),toolUseId:capture.toolUseId};
  }
  return locator;
}
export function sourceHint(source) {
  return {source_id:source.sourceId,asset_id:source.assetId||null,image_sha256:source.imageSha256||null,filename:source.filename,source_kind:source.sourceKind,locator:source.locator||null};
}
export function resolverRequest(body,catalog,{fallback=false}={}) {
  const ids=catalog.map(s=>s.sourceId);
  const instructions=`[${RESOLVER_MARKER}]\nYou are the Proxy's internal visual intent resolver. Use the ENTIRE Main context and CURRENT user task, not just keywords. Decide whether the task requires new visual observations (inspect), existing complete evidence fully covers it (reuse), or it does not require visual evidence (skip). Select only relevant source_ids from the catalog. A source handle is not pixels. Never answer the task or claim to see images. Reuse is valid only for supplied complete evidence that actually answers the current question. A new question, missing answer, partial evidence, or requested current/new screen requires inspect. ${fallback?'Return one JSON object with action, source_ids, reason and optionally temporal_scope.':'Call resolve_visual_intent exactly once.'}\nCATALOG_JSON\n${JSON.stringify(catalog.map(s=>({...sourceHint(s),evidence:s.evidence||null})))}`;
  const next=appendVisualSystem(body,instructions);next.stream=false;next.max_tokens=1536;
  // Internal budget is independent of a caller's extended-thinking budget.
  delete next.thinking;delete next.output_config;
  next.tools=fallback?[]:[{name:'resolve_visual_intent',description:'Select relevant image sources and evidence disposition for the current task.',input_schema:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['skip','reuse','inspect']},source_ids:{type:'array',maxItems:4,uniqueItems:true,items:{type:'string',enum:ids}},reason:{type:'string'},temporal_scope:{type:'string',enum:['original','current','unspecified']}},required:['action','source_ids','reason']}}];
  if(fallback)delete next.tool_choice;else next.tool_choice={type:'tool',name:'resolve_visual_intent'};
  next.messages.push({role:'user',content:[{type:'text',text:'Resolve the current task against the catalog. Preserve uncertainty and use only listed sources.'}]});
  return next;
}
export function parseResolution(response,catalog,{fallback=false}={}) {
  let result;
  if(fallback){const text=(response?.content||[]).map(b=>b.type==='text'?b.text:b.type==='thinking'?b.thinking:'').join('\n');const first=text.indexOf('{'),last=text.lastIndexOf('}');try{result=JSON.parse(text.slice(first,last+1));}catch{}}
  else {const calls=(response?.content||[]).filter(b=>b.type==='tool_use'&&b.name==='resolve_visual_intent');if(calls.length===1)result=calls[0].input;}
  const ids=result?.source_ids;
  if(!['skip','reuse','inspect'].includes(result?.action)||!Array.isArray(ids)||ids.length>4||new Set(ids).size!==ids.length||ids.some(id=>!catalog.some(s=>s.sourceId===id))||(result.action!=='skip'&&!ids.length))throw new Error('visual_intent_resolution_invalid');
  return {action:result.action,sourceIds:ids,temporalScope:['original','current'].includes(result.temporal_scope)?result.temporal_scope:'unspecified'};
}
export function isCompleteEvidence(evidence) {
  const p=evidence?.perception, plan=evidence?.plan;
  return p?.status==='complete' && plan?.source_ids?.length===1 && Array.isArray(plan?.questions) && plan.questions.length>0
    && plan.questions.every(q=>p.answers?.some(a=>a.question_id===q.id && String(a.answer||'').trim()))
    && !(p.source_results||[]).some(s=>s.unresolved?.length);
}
export function remapEvidence(evidence,sourceId,records=[]) {
  const copy=structuredClone(evidence);
  const ids=copy.plan?.source_ids;
  if(!Array.isArray(ids)||!sourceId)return null;
  const mapping=new Map();
  if(ids.length===1)mapping.set(ids[0],sourceId);
  else for(const id of ids){
    const binding=copy.sourceBindings?.find(b=>b.sourceId===id);
    const record=records.find(r=>binding?.assetId&&r.assetId===binding.assetId);
    if(!record)return null;
    mapping.set(id,record.sourceId);
  }
  copy.plan.source_ids=ids.map(id=>mapping.get(id));
  const ref=value=>{const colon=String(value).indexOf(':');return colon>0&&mapping.has(value.slice(0,colon))?`${mapping.get(value.slice(0,colon))}${value.slice(colon)}`:value;};
  for(const answer of copy.perception.answers||[]){answer.source_ids=answer.source_ids?.map(id=>mapping.get(id)||id);answer.support_refs=answer.support_refs?.map(ref);}
  for(const result of copy.perception.source_results||[])result.source_id=mapping.get(result.source_id)||result.source_id;
  copy.sourceId=sourceId;return copy;
}
export function hasImagePayload(messages){
  const scan=content=>Array.isArray(content)&&content.some(b=>b?.type==='image'||b?.type==='tool_result'&&scan(b.content));
  return (messages||[]).some(m=>scan(m?.content));
}
// Native Main retains its raw images; internal planning gets a text-only view
// of the same conversation, with an explicit marker instead of opaque pixels.
export function imageFreePlanningBody(body){
  const next=structuredClone(body);
  const scan=content=>Array.isArray(content)?content.map(b=>{
    if(b?.type==='image')return {type:'text',text:'[VCC_NATIVE_IMAGE] Pixels are available only to native Main. This image is not one of the directed source handles; do not infer its contents.'};
    if(b?.type==='tool_result')return {...b,content:scan(b.content)};
    return b;
  }):content;
  next.messages=(next.messages||[]).map(m=>({...m,content:scan(m.content)}));
  return next;
}
export function sourceLocators(hints=[]){return hints.flatMap(h=>[h.locator,h.locator?.alternative]).filter(Boolean);}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}

function schemaAccepts(value,schema={}) {
  if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))return false;
  if(schema.anyOf&&!schema.anyOf.some(s=>schemaAccepts(value,s)))return false;
  if(schema.oneOf&&schema.oneOf.filter(s=>schemaAccepts(value,s)).length!==1)return false;
  const types=Array.isArray(schema.type)?schema.type:schema.type?[schema.type]:[];
  if(types.length&&!types.some(type=>type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):type==='array'?Array.isArray(value):type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):type==='null'?value===null:typeof value===type))return false;
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    if((schema.required||[]).some(k=>!Object.hasOwn(value,k)))return false;
    if(schema.additionalProperties===false&&Object.keys(value).some(k=>!Object.hasOwn(schema.properties||{},k)))return false;
    for(const [k,v]of Object.entries(value))if(schema.properties?.[k]&&!schemaAccepts(v,schema.properties[k]))return false;
  }
  if(Array.isArray(value)&&schema.items&&!value.every(v=>schemaAccepts(v,schema.items)))return false;
  return true;
}
export function clientImageTools(tools=[]) {
  return tools.filter(t=>t?.name && /(?:read|screenshot|capture|attachment|view.*image|image.*view|download.*file|fetch.*file|tool.?search)/i.test(t.name) && !/^proxy_visual_query$|^submit_visual_plan$|^resolve_visual_intent$/.test(t.name));
}
export function validClientImageCall(call,tools,hints=[]) {
  const tool=clientImageTools(tools).find(t=>t.name===call?.name);
  if(call?.type!=='tool_use'||!call.id||!tool||!schemaAccepts(call.input,tool.input_schema||{}))return false;
  if(/(?:^|[_:])read$/i.test(call.name)){
    const file=call.input?.file_path||call.input?.path||call.input?.filename;
    const known=hints.flatMap(h=>[h.locator?.input?.file_path,h.locator?.input?.path,h.locator?.input?.filename,h.returnedPath]).filter(Boolean);
    if(!file || !known.includes(file))return false;
  }else if(!/tool.?search/i.test(call.name)){
    const locators=sourceLocators(hints).filter(l=>l.toolName===call.name);
    if(!locators.some(l=>JSON.stringify(canonical(l.input))===JSON.stringify(canonical(call.input))))return false;
  }
  return true;
}
export function toolSignature(call){return digest(JSON.stringify([call.name,canonical(call.input)]));}
