import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualEvidenceStateStore, visualEvidenceIdentity } from '../src/visual/visual-evidence-state.js';

test('V0.30.6 visual evidence state persists resolved evidence per Claude Code session and image hash', () => {
  const store=new VisualEvidenceStateStore({retentionMs:60000,maxEntries:8});
  const key=visualEvidenceIdentity({sessionId:'sess-a',imageSha256:'a'.repeat(64)});
  const plan={schema_version:'visual-query-plan-v1',source_ids:['img_01'],objective:'Inspect',questions:[{id:'q1',question:'Visible?'}],requested_evidence:[],detail_level:'normal'};
  const perception={schema_version:'visual-perception-v1',status:'complete',answers:[{question_id:'q1',answer:'Yes',confidence:0.9,source_ids:['img_01'],support_refs:['img_01:e1']}],source_results:[{source_id:'img_01',evidence:[{evidence_id:'e1',kind:'layout',observation:'Visible',confidence:0.9}],relationships:[],unresolved:[]}],needs_followup:false};
  store.setResolved(key,{plan,perception,sourceId:'img_01'});
  const state=store.get(key);
  assert.equal(state.status,'RESOLVED');
  assert.equal(state.perception.status,'complete');
});

test('V0.30.6 retryable planner failure remains retryable instead of becoming resolved unavailable evidence', () => {
  const store=new VisualEvidenceStateStore({retentionMs:60000,maxEntries:8});
  const key=visualEvidenceIdentity({sessionId:'sess-a',imageSha256:'b'.repeat(64)});
  store.setRetryableFailed(key,{code:'visual_query_planner_tool_missing'});
  const state=store.get(key);
  assert.equal(state.status,'RETRYABLE_FAILED');
  assert.equal(state.code,'visual_query_planner_tool_missing');
});
