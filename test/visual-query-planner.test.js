import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_QUERY_PLANNER_MARKER,
  buildVisualQueryPlannerRequest,
  buildVisualQueryPlannerFallbackRequest,
  parseVisualQueryPlan,
  parseVisualQueryPlanFallback,
  createSyntheticVisualExchange,
} from '../src/visual/visual-query-planner.js';

test('V0.30.5 planner preserves the full Main context and forces one internal submit_visual_plan tool', () => {
  const original = {
    model:'m', stream:true,
    system:'ORIGINAL_SYSTEM',
    tools:[{name:'Bash',description:'shell',input_schema:{type:'object'}}],
    messages:[
      {role:'user',content:'build the page'},
      {role:'assistant',content:[{type:'tool_use',id:'r1',name:'Read',input:{file_path:'/tmp/s.png'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'r1',content:'image result'}]},
    ],
  };
  const request = buildVisualQueryPlannerRequest(original, { sourceIds:['img_01'] });
  assert.equal(request.stream,false);
  assert.match(String(request.system), /ORIGINAL_SYSTEM/);
  assert.match(String(request.system), new RegExp(VISUAL_QUERY_PLANNER_MARKER));
  assert.deepEqual(request.messages.slice(0, original.messages.length), original.messages);
  assert.match(JSON.stringify(request.messages.at(-1)), /img_01/);
  assert.equal(request.tools.length,1);
  assert.equal(request.tools[0].name,'submit_visual_plan');
  assert.deepEqual(request.tool_choice,{type:'tool',name:'submit_visual_plan'});
});

test('V0.30.5 planner parses submit_visual_plan tool input even when thinking or prose blocks are present', () => {
  const plan = parseVisualQueryPlan({content:[
    {type:'thinking',thinking:'I need to inspect layout.'},
    {type:'text',text:'Planning complete.'},
    {type:'tool_use',id:'vp1',name:'submit_visual_plan',input:{schema_version:'visual-query-plan-v1',source_ids:['img_01'],objective:'Inspect layout',questions:[{id:'q1',question:'Is layout intact?'}],requested_evidence:['layout'],detail_level:'high'}},
  ]}, ['img_01']);
  assert.equal(plan.objective,'Inspect layout');
  assert.equal(plan.questions[0].id,'q1');
  assert.equal(plan.detail_level,'high');
});


test('V0.30.5 planner rejects free-form JSON text when submit_visual_plan was not called', () => {
  assert.throws(() => parseVisualQueryPlan({content:[{type:'text',text:JSON.stringify({
    schema_version:'visual-query-plan-v1',source_ids:['img_01'],objective:'Inspect layout',
    questions:[{id:'q1',question:'Is layout intact?'}],requested_evidence:['layout'],detail_level:'high',
  })}]}, ['img_01']), (error) => error?.code === 'visual_query_planner_tool_missing');
});

test('V0.30.4 synthetic visual exchange preserves tool_result semantics without exposing a callable tool', () => {
  const plan={source_ids:['img_01'],objective:'Inspect layout',questions:[{id:'q1',question:'Is layout intact?'}],requested_evidence:['layout'],detail_level:'high'};
  const perception={schema_version:'visual-perception-v1',status:'complete',answers:[],source_results:[],needs_followup:false};
  const exchange=createSyntheticVisualExchange(plan,perception,{toolUseId:'auto-1'});
  assert.equal(exchange[0].content[0].type,'tool_use');
  assert.equal(exchange[0].content[0].name,'proxy_visual_query');
  assert.equal(exchange[1].content[0].type,'tool_result');
  assert.equal(exchange[1].content[0].tool_use_id,'auto-1');
  assert.match(exchange[1].content[0].content,/visual-perception-v1/);
});


test('V0.30.6 planner fallback preserves the complete Main context and asks for bounded JSON only after tool_missing', () => {
  const original = {
    model:'m', stream:true, max_tokens:32768,
    system:'FULL_MAIN_SYSTEM_306',
    tools:[{name:'Bash',description:'shell',input_schema:{type:'object'}}],
    messages:[
      {role:'user',content:'FULL_MAIN_CONTEXT_306 build and inspect the page'},
      {role:'assistant',content:[{type:'tool_use',id:'r1',name:'Read',input:{file_path:'/tmp/s.png'}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'r1',content:'image result'}]},
    ],
  };
  const primaryResponse={content:[{type:'text',text:'I should inspect layout, text clipping and the footer.'}]};
  const fallback=buildVisualQueryPlannerFallbackRequest(original,{sourceIds:['img_01'],primaryResponse});
  assert.equal(fallback.stream,false);
  assert.match(String(fallback.system),/FULL_MAIN_SYSTEM_306/);
  assert.match(JSON.stringify(fallback.messages),/FULL_MAIN_CONTEXT_306/);
  assert.match(JSON.stringify(fallback.messages),/I should inspect layout/);
  assert.deepEqual(fallback.tools,[]);
  assert.equal('tool_choice' in fallback,false);
  assert.ok(fallback.max_tokens <= 1024);
});

test('V0.30.6 planner fallback parses a JSON object from text or thinking without changing the visual plan schema', () => {
  const plan=parseVisualQueryPlanFallback({content:[
    {type:'thinking',thinking:'Planning only. {"schema_version":"visual-query-plan-v1","source_ids":["img_01"],"objective":"Inspect screenshot","questions":[{"id":"layout","question":"Is anything clipped or overlapping?"}],"requested_evidence":["layout"],"detail_level":"high"}'},
  ]},['img_01']);
  assert.equal(plan.objective,'Inspect screenshot');
  assert.deepEqual(plan.source_ids,['img_01']);
  assert.equal(plan.questions[0].id,'layout');
});

test('V0.30.7 internal planner bounded budgets are compatible with an extended-thinking Main request',()=>{
  const body={model:'m',system:'full system',messages:[{role:'user',content:'complete original task'}],thinking:{type:'enabled',budget_tokens:8192},output_config:{effort:'high'},max_tokens:32768};
  for(const build of [buildVisualQueryPlannerRequest,buildVisualQueryPlannerFallbackRequest]){
    const request=build(body,{sourceIds:['img_01']});
    assert.equal(request.thinking,undefined);
    assert.deepEqual(request.messages[0],body.messages[0]);
    assert.equal(body.thinking.budget_tokens,8192,'caller remains unchanged');
  }
});
