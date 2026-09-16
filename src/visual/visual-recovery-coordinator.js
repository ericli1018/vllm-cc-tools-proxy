import { HttpError } from '../lib/http.js';
import { normalizeImage as defaultNormalizeImage } from '../parsers/image.js';
import { buildVisualQueryPlannerRequest, buildVisualQueryPlannerFallbackRequest, parseVisualQueryPlan, parseVisualQueryPlanFallback, createSyntheticVisualExchange, unavailableVisualPerception } from './visual-query-planner.js';
import { injectDirectedVisualContract } from './visual-query-tool.js';
import { appendVisualSystem, collectVisualContext, originalLocator, resolverRequest, parseResolution, isCompleteEvidence, remapEvidence, sourceHint, clientImageTools, validClientImageCall, toolSignature, digest, REACQUIRE_MARKER, sourceLocators } from './visual-recovery-context.js';

const KINDS=['direct_image','read_image','tool_result_image'];
const ACTIVE=new Set(['required','waiting_client','needs_read','retry']);
function updateTexts(messages,fn){
  const walk=(content,index,parentId='')=>{
    if(typeof content==='string')return fn(content,index,parentId);
    if(!Array.isArray(content))return content;
    return content.map(b=>b?.type==='text'?{...b,text:fn(b.text,index,parentId)}:b?.type==='tool_result'?{...b,content:walk(b.content,index,b.tool_use_id)}:b);
  };
  return messages.map((m,i)=>({...m,content:walk(m.content,i)}));
}
function toolResultPath(block){
  const parts=typeof block?.content==='string'?[block.content]:(block?.content||[]).filter(x=>x.type==='text').map(x=>x.text);
  for(const text of parts){
    try{const j=JSON.parse(text);const p=j?.file_path||j?.path||j?.filename;if(typeof p==='string'&&p)return p;}catch{}
    const match=String(text).match(/(?:[A-Za-z]:[\\/]|\/)[^\n"<>]*?\.(?:png|jpe?g|webp|gif|bmp)(?=$|[\s"'`])/i);if(match)return match[0].trim();
  }
  return '';
}
function fallbackPlan(ids){return {schema_version:'visual-query-plan-v1',source_ids:ids,objective:'Resolve visual evidence needed by the current task.',questions:[{id:'visual_unavailable',question:'What observable information is needed for this task?'}],requested_evidence:[],detail_level:'normal'};}

export class VisualRecoveryCoordinator {
  constructor({session,store,sessionId,requestId,messages,config,callMain,perceive,normalizeImage=defaultNormalizeImage,signal,onDiagnostic=()=>{}}){
    Object.assign(this,{session,store,sessionId,requestId,config,callMain,perceive,normalizeImage,signal,onDiagnostic});
    this.context=collectVisualContext(messages);this.records=new Map();this.prepared=false;this.exchangeIndex=0;this.activeRecovery=null;this.replayResponse=null;this.body=null;
  }
  async emit(event,fields={}){await this.onDiagnostic(event,fields);}
  async saveRecovery(value){await this.store.saveRecovery(this.sessionId,value);this.activeRecovery=value;return value;}
  async capture(record){
    const provenance=record.provenances?.at(-1)||record.provenance||{};
    const locator=originalLocator(this.context,provenance);
    const saved=await this.store.putSource(this.sessionId,{...record,locator,provenance});
    const value={...record,...saved,sourceId:record.sourceId,sourceBuffer:record.sourceBuffer,normalized:record.normalized,locator:saved?.locator||locator};
    Object.assign(record,{assetId:value.assetId,locator:value.locator});this.records.set(record.sourceId,value);return value;
  }
  async hydrate(body){
    for(const id of this.session.sourceIds()){
      const record=this.session.get(id);
      const toolId=(record?.provenances?.at(-1)||record?.provenance)?.toolUseId;
      if(record?.sourceBuffer?.length&&!this.context.results.get(toolId)?.block?.is_error)await this.capture(record);
    }
    const stored=await this.store.listSources(this.sessionId);
    for(const ref of this.context.references){
      let meta=ref.manifest.asset_id?await this.store.getSource(this.sessionId,ref.manifest.asset_id):null;
      const locator=originalLocator(this.context,{toolUseId:ref.toolUseId});
      if(!meta&&locator){
        const matches=stored.filter(s=>s.locator?.toolName===locator.toolName&&JSON.stringify(s.locator.input)===JSON.stringify(locator.input));
        if(matches.length===1)meta=matches[0];
      }
      // An old request-local img_01 is never a global lookup key.
      const local=[...this.records.values()].find(s=>meta?.assetId?s.assetId===meta.assetId:s.provenances?.some(p=>ref.toolUseId&&p.toolUseId===ref.toolUseId));
      if(local){ref.resolvedSourceId=local.sourceId;continue;}
      const registered=this.session.register({sourceId:ref.manifest.source_id,sourceBuffer:Buffer.alloc(0),imageSha256:meta?.imageSha256||'',filename:meta?.filename||ref.manifest.filename||'image',mediaType:meta?.mediaType||ref.manifest.media_type||'image/png',sourceKind:meta?.sourceKind||ref.manifest.source_kind||'direct_image',provenance:{messageIndex:ref.messageIndex,sourceKind:meta?.sourceKind||ref.manifest.source_kind||'direct_image',toolUseId:ref.toolUseId}});
      const record=this.session.get(registered.sourceId);
      this.records.set(record.sourceId,{...record,...(meta||{}),sourceId:record.sourceId,sourceBuffer:record.sourceBuffer,normalized:record.normalized,locator:meta?.locator||locator});
      ref.resolvedSourceId=record.sourceId;
    }
    // Compact history can omit the manifest, but durable sources remain session scoped.
    if(!this.records.size){
      for(const meta of stored.slice(0,16)){
        const reg=this.session.register({...meta,sourceBuffer:Buffer.alloc(0),provenance:{messageIndex:-1,sourceKind:meta.sourceKind}});
        this.records.set(reg.sourceId,{...this.session.get(reg.sourceId),...meta,sourceId:reg.sourceId,sourceBuffer:Buffer.alloc(0),normalized:null});
      }
    }
    const next=structuredClone(body);
    next.messages=updateTexts(next.messages,(text,index,parentId)=>String(text||'').replace(/\[VCC_VISUAL_SOURCE[^\]]*\]\s*(\{[^\n]*\})\s*\[VCC_VISUAL_SOURCE_END\]/g,(whole,json)=>{
      try{
        const data=JSON.parse(json);
        const ref=this.context.references.find(r=>r.messageIndex===index&&r.toolUseId===parentId&&r.text===whole);
        const record=ref?this.records.get(ref.resolvedSourceId):this.records.get(data.source_id);
        if(!record)return whole;
        return `[VCC_VISUAL_SOURCE version=1]\n${JSON.stringify({...data,source_id:record.sourceId,...(record.assetId?{asset_id:record.assetId,image_sha256:record.imageSha256}:{}),visual_evidence_status:record.evidence?.perception?.status||'pending'})}\n[VCC_VISUAL_SOURCE_END]`;
      }catch{return whole;}
    }));
    return this.records.size?injectDirectedVisualContract(next):next;
  }
  async recoverPending(body){
    const recoveries=await this.store.listRecoveries(this.sessionId);
    const blocked=recoveries.find(r=>r.status==='failed'&&r.failure==='original_image_changed'&&r.intentKey===this.context.intentKey);
    if(blocked){
      this.sourceBlocked=true;
      return appendVisualSystem(body,'[VCC_VISUAL_SOURCE_UNAVAILABLE] The requested ORIGINAL image was replaced. The persisted original-image failure is still unresolved. Ask for that specific original; do not infer it from the replacement.');
    }
    const pending=recoveries.find(r=>ACTIVE.has(r.status)&&r.intentKey===this.context.intentKey);
    if(!pending)return body;
    this.activeRecovery=pending;
    const returned=(pending.toolCalls||[]).map(c=>({call:c,result:this.context.results.get(c.id)})).filter(x=>x.result?.messageIndex===this.context.currentIndex);
    if(!returned.length){
      if(pending.status==='waiting_client'&&pending.lastResponse)this.replayResponse=structuredClone(pending.lastResponse);
      return body;
    }
    const received=[...this.records.values()].filter(s=>s.provenances?.some(p=>returned.some(x=>x.call.id===p.toolUseId&&!x.result.block.is_error)&&p.messageIndex===this.context.currentIndex)&&s.sourceBuffer?.length);
    if(received.length){
      const replacements=[];
      for(const image of received){
        const call=returned.find(x=>image.provenances?.some(p=>p.toolUseId===x.call.id))?.call;
        const file=call?.input?.file_path||call?.input?.path||call?.input?.filename;
        const hint=(pending.sourceHints||[]).find(h=>file&&[h.returnedPath,h.locator?.input?.file_path,h.locator?.input?.path,h.locator?.input?.filename].includes(file))
          || (pending.sourceHints?.length===1?pending.sourceHints[0]:null);
        if(hint)replacements.push({oldAssetId:hint.asset_id,oldSourceId:hint.source_id,newAssetId:image.assetId});
      }
      const changed=replacements.some(r=>{const hint=pending.sourceHints.find(h=>h.asset_id===r.oldAssetId&&h.source_id===r.oldSourceId);return hint?.image_sha256&&received.find(s=>s.assetId===r.newAssetId)?.imageSha256!==hint.image_sha256;});
      if(changed&&pending.temporalScope==='original'){
        await this.saveRecovery({...pending,status:'failed',failure:'original_image_changed'});
        this.sourceBlocked=true;
        return appendVisualSystem(body,'[VCC_VISUAL_SOURCE_UNAVAILABLE]\nThe requested ORIGINAL image was replaced. The returned image is a different version and cannot establish facts about the original. Ask for that original image if needed.');
      }
      await this.saveRecovery({...pending,status:'returned',receivedAssetIds:received.map(s=>s.assetId),replacements:[...(pending.replacements||[]),...replacements],lastResponse:null});
      await this.emit('visual_source_reacquired',{recovery_id:pending.id,source_ids:received.map(s=>s.sourceId),version_changed:changed});
      if(changed)body=appendVisualSystem(body,'[VCC_VISUAL_SOURCE_VERSION_CHANGED]\nThe frontend returned a new image version. Old visual evidence remains about the old version; inspect the new source separately and preserve this distinction.');
      return body;
    }
    const error=returned.some(x=>x.result.block.is_error);
    const returnedPath=returned.map(x=>toolResultPath(x.result.block)).find(Boolean);
    const hints=(pending.sourceHints||[]).map(h=>({...h,...(returnedPath?{returnedPath}:{} )}));
    await this.saveRecovery({...pending,status:!error&&returnedPath?'needs_read':'retry',sourceHints:hints,lastResponse:null,lastError:error?'client_tool_error':returnedPath?'path_only_result':'client_result_has_no_image'});
    return body;
  }
  async plan(body,ids){
    await this.emit('visual_query_planning_started',{source_ids:ids});
    const primary=await this.callMain(buildVisualQueryPlannerRequest(body,{sourceIds:ids}));
    try {return parseVisualQueryPlan(primary,ids);}
    catch(error){
      if(!error?.retryable)throw error;
      await this.emit('visual_query_planning_fallback_started',{primary_code:error.code,source_ids:ids});
      const fallback=await this.callMain(buildVisualQueryPlannerFallbackRequest(body,{sourceIds:ids,primaryResponse:primary}));
      const plan=parseVisualQueryPlanFallback(fallback,ids);
      await this.emit('visual_query_planning_fallback_completed',{source_ids:ids});return plan;
    }
  }
  inject(body,plan,perception){
    const next=injectDirectedVisualContract(structuredClone(body));
    next.messages.push(...createSyntheticVisualExchange(plan,perception,{toolUseId:`vcc-auto-visual-${this.requestId}-${++this.exchangeIndex}`}));
    return next;
  }
  async unavailable(body,ids,code,detail){
    const p=fallbackPlan(ids);return this.inject(body,p,unavailableVisualPerception(p,{code,detail}));
  }
  async resolve(body,catalog){
    try{return parseResolution(await this.callMain(resolverRequest(body,catalog)),catalog);}
    catch(error){
      if(this.signal?.aborted)throw error;
      await this.emit('visual_intent_resolution_retry',{code:error.code||error.message});
      try{return parseResolution(await this.callMain(resolverRequest(body,catalog,{fallback:true})),catalog,{fallback:true});}
      catch(last){if(this.signal?.aborted)throw last;await this.emit('visual_intent_resolution_failed',{code:last.code||last.message});return null;}
    }
  }
  async materialize(record){
    if(record.sourceBuffer?.length&&record.normalized)return true;
    const buffer=record.assetId?await this.store.getBytes(this.sessionId,record.assetId):null;
    if(!buffer)return false;
    const normalized=await this.normalizeImage(buffer,{...this.config.limits,signal:this.signal});
    Object.assign(record,{sourceBuffer:buffer,normalized});Object.assign(this.session.get(record.sourceId),{sourceBuffer:buffer,normalized});return true;
  }
  async requestSource(body,selected,plan,temporalScope,targets=selected){
    const hints=selected.map(sourceHint);
    const identity=selected.map(s=>s.assetId||digest(JSON.stringify([s.filename,s.locator]))).sort();
    const id=`vr_${digest(`${this.sessionId}\n${this.context.intentKey}\n${identity.join(',')}`).slice(0,40)}`;
    let recovery=this.activeRecovery&&ACTIVE.has(this.activeRecovery.status)?this.activeRecovery:await this.store.getRecovery(this.sessionId,id);
    if(!recovery)recovery={id,assetIds:selected.map(s=>s.assetId).filter(Boolean),sourceHints:hints,targetHints:targets.map(sourceHint),intentKey:this.context.intentKey,attempts:0,toolSteps:0,toolCalls:[],status:'required',plan,temporalScope,signatures:[]};
    if(recovery.status==='failed'||recovery.attempts>=2&&recovery.status==='retry'||recovery.toolSteps>=4){
      await this.saveRecovery({...recovery,status:'failed',failure:'visual_source_recovery_exhausted'});
      return appendVisualSystem(await this.unavailable(body,selected.map(s=>s.sourceId),'visual_source_recovery_exhausted','Frontend image recovery could not obtain usable pixels within its bounded attempts.'),'[VCC_VISUAL_SOURCE_UNAVAILABLE]\nAutomatic source recovery is exhausted for this task. Explain the source failure and ask the user for the specific missing original image if needed. Do not repeat the failed source tools.');
    }
    const eligible=this.acquisitionTools(body.tools,recovery);
    if(!eligible.length){
      await this.saveRecovery({...recovery,status:'failed',failure:'client_image_tool_unavailable'});
      return appendVisualSystem(await this.unavailable(body,selected.map(s=>s.sourceId),'client_image_tool_unavailable','The frontend has not provided an image retrieval tool.'),'[VCC_VISUAL_SOURCE_UNAVAILABLE]\nNo usable frontend image retrieval tool is available. Ask the user to provide this specific missing image; do not invent a tool or image content.');
    }
    recovery={...recovery,sourceHints:recovery.status==='needs_read'?recovery.sourceHints:hints,plan:recovery.plan||plan,temporalScope:recovery.temporalScope||temporalScope};
    await this.saveRecovery(recovery);
    await this.emit('visual_source_reacquire_required',{recovery_id:recovery.id,attempts:recovery.attempts});
    return appendVisualSystem(body,`[${REACQUIRE_MARKER}]\nThe current task requires image evidence, but the original pixels are absent from this request and all available Proxy caches. You must now use a real available frontend Read/screenshot/attachment retrieval tool to obtain the requested image. This is a client-tool selection round, not the perception planner. Use the exact available tool schema and source locator. Call the tool; merely saying you will read an image is not execution. Do not answer the visual task yet. If a capture returns only a file path, Read that path next. Use source metadata and returned tool paths only; never invent a path. If the original is required, do not replace it with a current screenshot.\nRECOVERY_JSON\n${JSON.stringify({recovery_id:recovery.id,source_hints:recovery.sourceHints,questions:recovery.plan?.questions||plan?.questions,objective:recovery.plan?.objective||plan?.objective,last_error:recovery.lastError||null,attempts:recovery.attempts,available_tools:eligible.map(t=>t.name)})}`);
  }
  acquisitionTools(tools,recovery){
    return clientImageTools(tools).filter(tool=>{
      if(recovery.temporalScope==='original'&&/screenshot|capture/i.test(tool.name))return false;
      if(/(?:^|[_:])read$/i.test(tool.name))return (recovery.sourceHints||[]).some(h=>h.returnedPath||h.locator?.input?.file_path||h.locator?.input?.path||h.locator?.input?.filename);
      return /tool.?search/i.test(tool.name)||sourceLocators(recovery.sourceHints).some(l=>l.toolName===tool.name);
    });
  }
  async prepare(body){
    const sourceIds=this.session.sourceIds();
    const previousIds=this.preparedSourceIds||[];
    if(this.prepared&&JSON.stringify(previousIds)===JSON.stringify(sourceIds))return body;
    const addedIds=this.prepared?sourceIds.filter(id=>!previousIds.includes(id)):[];
    this.prepared=true;this.preparedSourceIds=sourceIds;
    let next=await this.hydrate(body);next=await this.recoverPending(next);
    if(this.replayResponse||this.sourceBlocked){this.body=next;return next;}
    const catalog=[...this.records.values()].sort((a,b)=>Number(b.provenance?.messageIndex??-1)-Number(a.provenance?.messageIndex??-1)).slice(0,16);
    if(!catalog.length){this.prepared=false;this.body=next;return next;}
    const freshIds=this.session.sourceIdsForMessageIndex(this.context.currentIndex,{sourceKinds:KINDS});
    let selected=[...new Set([...freshIds,...addedIds])].map(id=>this.records.get(id)).filter(Boolean),temporalScope='unspecified';
    const replayEvidence=selected[0]?.evidence;
    if(!this.activeRecovery&&replayEvidence?.intentKey===this.context.intentKey&&replayEvidence.followupUsed){
      const restored=remapEvidence(replayEvidence,selected[0].sourceId,catalog);
      if(restored&&selected.length===restored.plan.source_ids.length&&selected.every(s=>restored.plan.source_ids.includes(s.sourceId))){
        next=this.inject(next,restored.plan,restored.perception);
        next=appendVisualSystem(next,'[VCC_VISUAL_FOLLOWUP_EXHAUSTED] This exact image/task has consumed its targeted follow-up. Preserve all remaining uncertainty.');
        this.body=next;return next;
      }
    }
    if(this.activeRecovery&&(ACTIVE.has(this.activeRecovery.status)||this.activeRecovery.status==='returned')) {
      selected=(this.activeRecovery.targetHints||this.activeRecovery.sourceHints||[]).map(h=>{
        const replacement=(this.activeRecovery.replacements||[]).findLast(r=>h.asset_id?r.oldAssetId===h.asset_id:r.oldSourceId===h.source_id);
        return catalog.find(s=>replacement?s.assetId===replacement.newAssetId:h.asset_id?s.assetId===h.asset_id:s.sourceId===h.source_id);
      }).filter(Boolean);
      selected=[...new Map(selected.map(s=>[s.sourceId,s])).values()];
      temporalScope=this.activeRecovery.status==='returned'?'unspecified':this.activeRecovery.temporalScope;
      if(!selected.length)selected=catalog.slice(0,1);
    } else if(!selected.length){
      const latest=this.session.latestSourceIds({sourceKinds:KINDS,beforeMessageIndex:this.context.currentIndex});
      const relevant=latest.length?catalog.filter(s=>latest.includes(s.sourceId)):catalog;
      const same=relevant.length===1&&relevant[0].evidence?.intentKey===this.context.intentKey;
      if(same&&(isCompleteEvidence(relevant[0].evidence)||relevant[0].evidence.followupUsed&&relevant[0].evidence.plan?.source_ids?.length===1)){
        const e=remapEvidence(relevant[0].evidence,relevant[0].sourceId);next=this.inject(next,e.plan,e.perception);
        if(!isCompleteEvidence(e))next=appendVisualSystem(next,'[VCC_VISUAL_FOLLOWUP_EXHAUSTED] The one targeted follow-up for this task has already run. Keep unresolved observations uncertain; do not claim complete evidence.');
        await this.emit('visual_evidence_state_reused',{source_id:relevant[0].sourceId});this.body=next;return next;
      }
      if(!this.context.newHuman&&!this.activeRecovery){
        if(same)selected=relevant;else{this.body=next;return next;}
      } else {
        const decision=await this.resolve(next,catalog);
        if(!decision){next=await this.unavailable(next,relevant.slice(0,4).map(s=>s.sourceId),'visual_intent_resolution_failed','The internal Main resolver could not determine whether and which visual sources are needed. Preserve uncertainty.');this.body=next;return next;}
        if(decision.action==='skip'){this.body=next;return next;}
        selected=decision.sourceIds.map(id=>this.records.get(id));temporalScope=decision.temporalScope;
        if(decision.action==='reuse'&&selected.every(s=>isCompleteEvidence(s.evidence))){
          for(const s of selected){const e=remapEvidence(s.evidence,s.sourceId);next=this.inject(next,e.plan,e.perception);await this.emit('visual_evidence_state_reused',{source_id:s.sourceId});}
          this.body=next;return next;
        }
      }
    }
    if(!selected.length){this.body=next;return next;}
    if(selected.length>4){next=await this.unavailable(next,selected.map(s=>s.sourceId),'visual_source_limit','At most four images can be inspected together. Select a smaller relevant set.');this.body=next;return next;}
    const ids=selected.map(s=>s.sourceId);
    let plan;
    try{plan=await this.plan(next,ids);await this.emit('visual_query_planning_completed',{source_ids:ids,question_count:plan.questions.length});}
    catch(error){
      if(this.signal?.aborted)throw error;
      next=await this.unavailable(next,ids,error.code||'visual_query_planner_failed','The Proxy could not obtain a valid task-specific visual plan.');
      for(const s of selected)if(s.assetId)await this.store.setEvidence(this.sessionId,s.assetId,{plan:fallbackPlan(ids),perception:unavailableVisualPerception(fallbackPlan(ids)),sourceId:s.sourceId,intentKey:this.context.intentKey});
      this.body=next;return next;
    }
    const available=await Promise.all(selected.map(s=>{
      const pendingSource=ACTIVE.has(this.activeRecovery?.status)&&(this.activeRecovery.sourceHints||[]).some(h=>h.asset_id?h.asset_id===s.assetId:h.source_id===s.sourceId);
      return temporalScope==='current'||pendingSource?false:this.materialize(s);
    }));
    if(available.some(v=>!v)){
      next=await this.requestSource(next,selected.filter((_,i)=>!available[i]),plan,temporalScope,selected);this.body=next;return next;
    }
    let result=await this.perceive(plan);next=this.inject(next,plan,result);
    let followupUsed=false;
    const sourceBindings=selected.map(s=>({sourceId:s.sourceId,assetId:s.assetId}));
    if(result.needs_followup){
      followupUsed=true;
      // Reserve before calling Main/Vision so interruption cannot silently reset the budget.
      for(const s of selected)if(s.assetId)await this.store.setEvidence(this.sessionId,s.assetId,{plan,perception:result,followupUsed,sourceBindings,intentKey:this.context.intentKey,sourceId:s.sourceId});
      await this.emit('visual_query_followup_started',{source_ids:ids});
      const followBody=appendVisualSystem(next,'[VCC_VISUAL_FOLLOWUP_V1]\nUse the complete context and supplied partial visual evidence. Ask only for still unresolved observable facts. This is the one permitted follow-up. Keep the question IDs of the unresolved questions so results can be reconciled.');
      try{
        const followPlan=await this.plan(followBody,ids);
        const second=await this.perceive(followPlan);next=this.inject(next,followPlan,second);
        // Keep both exchanges visible; the durable snapshot retains evidence for the original questions.
        result=mergePerceptions(plan,result,followPlan,second);
      }catch(error){if(this.signal?.aborted)throw error;await this.emit('visual_query_followup_failed',{code:error.code||error.message});}
    }
    for(const s of selected)if(s.assetId)await this.store.setEvidence(this.sessionId,s.assetId,{plan,perception:result,followupUsed,sourceBindings,intentKey:this.context.intentKey,sourceId:s.sourceId});
    if(this.activeRecovery?.status==='returned')await this.saveRecovery({...this.activeRecovery,status:'complete',lastResponse:null});
    await this.emit('visual_query_result_injected',{source_ids:ids,status:result.status,answer_count:result.answers?.length||0});
    this.body=next;return next;
  }
  async observeClientResponse(response){
    const recovery=this.activeRecovery;
    if(this.replayResponse||!recovery||!ACTIVE.has(recovery.status))return response;
    const eligible=this.acquisitionTools(this.body?.tools||[],recovery);
    const validate=r=>(r?.content||[]).filter(c=>validClientImageCall(c,eligible,recovery.sourceHints));
    let calls=validate(response);
    if(!calls.length&&eligible.length){
      const retry=appendVisualSystem(this.body,'[VCC_VISUAL_REACQUIRE_CORRECTION]\nYou did not return a valid declared frontend image acquisition tool call. Return one now using the provided source locator and exact tool schema.');
      retry.stream=false;retry.max_tokens=2048;delete retry.thinking;delete retry.output_config;
      retry.tools=eligible;if(eligible.length===1)retry.tool_choice={type:'tool',name:eligible[0].name};else delete retry.tool_choice;
      const corrected=await this.callMain(retry);calls=validate(corrected);response=corrected;
    }
    if(!calls.length){await this.saveRecovery({...recovery,status:'failed',failure:'visual_reacquire_tool_missing'});throw new HttpError(502,'Main did not issue a usable frontend image retrieval tool call.',{code:'visual_reacquire_tool_missing',retryable:false});}
    const repeated=calls.some(c=>(recovery.signatures||[]).includes(toolSignature(c)));
    if(repeated){await this.saveRecovery({...recovery,status:'failed',failure:'visual_reacquire_no_progress'});throw new HttpError(422,'Frontend image recovery repeated an unsuccessful action.',{code:'visual_reacquire_no_progress',retryable:false});}
    if((response.content||[]).some(c=>c.type==='tool_use'&&!calls.includes(c)))throw new HttpError(502,'Image recovery returned an invalid or unrelated tool call.',{code:'visual_reacquire_tool_invalid',retryable:false});
    const attempts=recovery.status==='needs_read'?recovery.attempts:recovery.attempts+1;
    const output={...response,stop_reason:'tool_use'};
    await this.saveRecovery({...recovery,status:'waiting_client',attempts,toolSteps:(recovery.toolSteps||0)+calls.length,toolCalls:calls.map(c=>({id:c.id,name:c.name,input:c.input})),signatures:[...(recovery.signatures||[]),...calls.map(toolSignature)],lastResponse:output});
    await this.emit('visual_source_client_handoff',{recovery_id:recovery.id,tool_use_ids:calls.map(c=>c.id),attempts});return output;
  }
}

function mergePerceptions(plan,first,followPlan,second){
  const merged=structuredClone(first),originalIds=new Set(plan.questions.map(q=>q.id));
  const answered=new Set((second.answers||[]).filter(a=>originalIds.has(a.question_id)).map(a=>a.question_id));
  const pending=new Set((second.source_results||[]).flatMap(s=>(s.unresolved||[]).map(u=>u.question_id)));
  const resolved=new Set([...answered].filter(id=>!pending.has(id)));
  // Namespacing preserves support references when the sensor reuses e1 across rounds.
  const follow=structuredClone(second);
  for(const s of follow.source_results||[])for(const e of s.evidence||[])e.evidence_id=`followup_${e.evidence_id}`;
  for(const a of follow.answers||[])a.support_refs=a.support_refs?.map(ref=>ref.replace(':',':followup_'));
  merged.answers=[...(merged.answers||[]).filter(a=>!resolved.has(a.question_id)),...(follow.answers||[]).filter(a=>originalIds.has(a.question_id))];
  for(const s of merged.source_results||[]){const extra=follow.source_results?.find(e=>e.source_id===s.source_id);if(!extra)continue;s.evidence.push(...extra.evidence);s.relationships.push(...extra.relationships);s.unresolved=[...s.unresolved.filter(u=>!resolved.has(u.question_id)),...extra.unresolved.filter(u=>!u.question_id||originalIds.has(u.question_id))];}
  merged.status=plan.questions.every(q=>merged.answers.some(a=>a.question_id===q.id))&&!merged.source_results.some(s=>s.unresolved.length)?'complete':'partial';merged.needs_followup=false;return merged;
}
