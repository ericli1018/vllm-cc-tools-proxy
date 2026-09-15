import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_QUERY_PLANNER_MARKER,
  buildVisualQueryPlannerRequest,
  parseVisualQueryPlan,
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
