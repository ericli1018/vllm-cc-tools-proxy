import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_QUERY_PLANNER_MARKER,
  buildVisualQueryPlannerRequest,
  parseVisualQueryPlan,
  createSyntheticVisualExchange,
} from '../src/visual/visual-query-planner.js';

test('V0.30.4 planner request is silent, tool-free, and scoped to fresh source ids', () => {
  const request = buildVisualQueryPlannerRequest({ model:'m', stream:true, tools:[{name:'Bash'}], messages:[{role:'user',content:'inspect'}] }, { sourceIds:['img_01'] });
  assert.equal(request.stream,false);
  assert.equal(request.tools.length,0);
  assert.match(String(request.system), new RegExp(VISUAL_QUERY_PLANNER_MARKER));
  assert.match(JSON.stringify(request.messages.at(-1)), /img_01/);
});

test('V0.30.4 planner parses bounded visual-query-plan-v1', () => {
  const plan = parseVisualQueryPlan({content:[{type:'text',text:JSON.stringify({schema_version:'visual-query-plan-v1',source_ids:['img_01'],objective:'Inspect layout',questions:[{id:'q1',question:'Is layout intact?'}],requested_evidence:['layout'],detail_level:'high'})}]}, ['img_01']);
  assert.equal(plan.objective,'Inspect layout');
  assert.equal(plan.questions[0].id,'q1');
  assert.equal(plan.detail_level,'high');
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
