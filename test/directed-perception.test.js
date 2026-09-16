import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectedVisualSession } from '../src/visual/directed-visual-session.js';
import { executeDirectedVisualQuery } from '../src/visual/directed-perception.js';
import { HttpError } from '../src/lib/http.js';

function fixtureSession() {
  const session = new DirectedVisualSession();
  session.register({
    sourceBuffer: Buffer.from('image'),
    mediaType: 'image/png',
    normalized: { buffer: Buffer.from('normalized'), mediaType: 'image/png', width: 640, height: 480, originalWidth: 640, originalHeight: 480 },
    filename: 'screen.png',
    sourceKind: 'direct_image',
    provenance: { origin: 'user' },
  });
  return session;
}

function toolUse() {
  return { name:'proxy_visual_query', input:{ source_ids:['img_01'], objective:'Find the reset signal.', questions:[{id:'q1',question:'What reset signal is visible?'}], detail_level:'high' } };
}

function cfg() {
  return { vllmVisionUrl:'http://vision.invalid', vllmVisionModel:'vision', vllmVisionProvider:'vllm', vllmVisionThink:false, vllmVisionTimeoutMs:1000, vllmVisionApiProtocol:'openai-chat', resourceProfile:'default', limits:{} };
}

const validResult = {
  schema_version:'visual-perception-v1', status:'complete',
  answers:[{question_id:'q1',answer:'RESET_N',confidence:0.9,source_ids:['img_01'],support_refs:['img_01:e1']}],
  source_results:[{source_id:'img_01',evidence:[{evidence_id:'e1',kind:'text',observation:'RESET_N',confidence:0.9}],relationships:[],unresolved:[]}],
  needs_followup:false,
};

test('V0.30.0 directed perception performs one strict JSON repair after malformed Sensor output', async () => {
  let calls = 0;
  const result = await executeDirectedVisualQuery(toolUse(), {
    session: fixtureSession(), config: cfg(),
    analyzeVisualAssets: async (_assets, options) => {
      calls += 1;
      if (calls === 1) return { markdown:'not-json' };
      assert.equal(options.allowCrops, false);
      assert.match(options.prompt, /repair/i);
      return { markdown:JSON.stringify(validResult) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'complete');
  assert.equal(result.answers[0].answer, 'RESET_N');
});

test('V0.30.0 directed perception returns structured unavailable evidence after Sensor service failure', async () => {
  const result = await executeDirectedVisualQuery(toolUse(), {
    session: fixtureSession(), config: cfg(),
    analyzeVisualAssets: async () => { throw new HttpError(503, 'down', { code:'vision_service_error', retryable:true }); },
  });
  assert.equal(result.schema_version, 'visual-perception-v1');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.needs_followup, false);
  assert.equal(result.source_results[0].unresolved[0].question_id, 'q1');
  assert.equal(result.source_results[0].unresolved[0].reason_code, 'service_unavailable');
  assert.equal(result.source_results[0].unresolved[0].retryable, true);
});


test('V0.30.1 schema repair receives the invalid Sensor output plus safe validation diagnostics and does not resend images', async () => {
  let calls = 0;
  const diagnostics = [];
  const invalidResult = {
    ...validResult,
    answers: [{ ...validResult.answers[0], source_ids: ['img_missing'] }],
  };
  const invalidText = JSON.stringify(invalidResult);
  const result = await executeDirectedVisualQuery(toolUse(), {
    session: fixtureSession(), config: cfg(),
    onDiagnostic: async (event, details) => diagnostics.push({ event, details }),
    analyzeVisualAssets: async (assets, options) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(assets.length, 1);
        return { markdown: invalidText };
      }
      assert.equal(assets.length, 0, 'schema repair must be text-only and must not resend the image');
      assert.equal(options.allowCrops, false);
      assert.match(options.prompt, /INVALID_SENSOR_OUTPUT/);
      assert.match(options.prompt, /img_missing/);
      assert.match(options.prompt, /VALIDATION_ERROR/);
      assert.match(options.prompt, /answers\[0\]\.source_ids\[0\]/);
      assert.match(options.prompt, /unknown_source_id/);
      return { markdown: JSON.stringify(validResult) };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'complete');
  const started = diagnostics.find((entry) => entry.event === 'visual_query_schema_repair_started');
  assert.equal(started?.details?.validation_stage, 'schema');
  assert.equal(started?.details?.validation_path, 'answers[0].source_ids[0]');
  assert.equal(started?.details?.validation_reason, 'unknown_source_id');
});

test('V0.30.1 normalizes conservative common Sensor schema variants before validation', async () => {
  let calls = 0;
  const variant = {
    schema_version: 'visual-perception-v1',
    status: 'complete',
    source_results: [{
      source_id: 'img_01',
      answers: [{ question_id: 'q1', answer: 'RESET_N', confidence: 96, support_refs: ['e1'] }],
      evidence: [{ id: 'e1', type: 'text', value: 'RESET_N', confidence: '98', bbox: [100.2, 100, 200.8, 140] }],
      relationships: [],
      unresolved: [],
    }],
    needs_followup: false,
  };
  const result = await executeDirectedVisualQuery(toolUse(), {
    session: fixtureSession(), config: cfg(),
    analyzeVisualAssets: async () => { calls += 1; return { markdown: JSON.stringify(variant) }; },
  });
  assert.equal(calls, 1, 'deterministic normalization should avoid a repair call');
  assert.equal(result.answers[0].source_ids[0], 'img_01');
  assert.equal(result.answers[0].support_refs[0], 'img_01:e1');
  assert.equal(result.answers[0].confidence, 0.96);
  assert.equal(result.source_results[0].evidence[0].evidence_id, 'e1');
  assert.equal(result.source_results[0].evidence[0].kind, 'text');
  assert.equal(result.source_results[0].evidence[0].observation, 'RESET_N');
  assert.equal(result.source_results[0].evidence[0].confidence, 0.98);
  assert.deepEqual(result.source_results[0].evidence[0].bbox, [100, 100, 201, 140]);
});

test('V0.30.1 malformed JSON repair exposes parse-stage diagnostics and includes the original invalid text', async () => {
  let calls = 0;
  const diagnostics = [];
  const result = await executeDirectedVisualQuery(toolUse(), {
    session: fixtureSession(), config: cfg(),
    onDiagnostic: async (event, details) => diagnostics.push({ event, details }),
    analyzeVisualAssets: async (assets, options) => {
      calls += 1;
      if (calls === 1) return { markdown: 'not-json-from-sensor' };
      assert.equal(assets.length, 0);
      assert.match(options.prompt, /not-json-from-sensor/);
      assert.match(options.prompt, /json_parse_failed/);
      return { markdown: JSON.stringify(validResult) };
    },
  });
  assert.equal(result.status, 'complete');
  const started = diagnostics.find((entry) => entry.event === 'visual_query_schema_repair_started');
  assert.equal(started?.details?.validation_stage, 'parse');
  assert.equal(started?.details?.validation_path, '$');
  assert.equal(started?.details?.validation_reason, 'json_parse_failed');
});

test('V0.30.1 DirectedVisualSession reuses one source id for the same image bytes', () => {
  const session = new DirectedVisualSession();
  const common = {
    sourceBuffer: Buffer.from('same-image'),
    mediaType: 'image/png',
    normalized: { buffer: Buffer.from('normalized'), mediaType: 'image/png', width: 640, height: 480, originalWidth: 640, originalHeight: 480 },
    filename: 'screen.png',
    sourceKind: 'read_image',
  };
  const first = session.register({ ...common, provenance: { origin: 'read', readSourceRef: 'same-ref', messageIndex: 1 } });
  const second = session.register({ ...common, provenance: { origin: 'read', readSourceRef: 'same-ref', messageIndex: 3 } });
  assert.equal(first.sourceId, 'img_01');
  assert.equal(second.sourceId, 'img_01');
  assert.deepEqual(session.sourceIds(), ['img_01']);
  assert.equal(session.get('img_01').provenances.length, 2);
});

test('V0.30.4 DirectedVisualSession resolves fresh source ids by current message provenance', () => {
  const session = new DirectedVisualSession();
  const common = {
    sourceBuffer: Buffer.from('same-image-v0304'), mediaType:'image/png',
    normalized:{buffer:Buffer.from('normalized-v0304'),mediaType:'image/png',width:10,height:10,originalWidth:10,originalHeight:10},
    filename:'screen.png', sourceKind:'read_image',
  };
  session.register({...common, provenance:{origin:'read',sourceKind:'read_image',messageIndex:1}});
  session.register({...common, provenance:{origin:'read',sourceKind:'read_image',messageIndex:3}});
  assert.deepEqual(session.sourceIdsForMessageIndex(1,{sourceKinds:['read_image']}),['img_01']);
  assert.deepEqual(session.sourceIdsForMessageIndex(3,{sourceKinds:['read_image']}),['img_01']);
  assert.deepEqual(session.sourceIdsForMessageIndex(2,{sourceKinds:['read_image']}),[]);
});

test('V0.30.7 incomplete old cached perception must not bypass current question coverage checks', async () => {
  let calls=0;
  const result=await executeDirectedVisualQuery(toolUse(), {
    session:fixtureSession(),config:cfg(),
    perceptionCache:{get:async()=>({result:{...validResult,answers:[]}}),set:async()=>true},
    analyzeVisualAssets:async()=>{calls++;return {markdown:JSON.stringify(validResult)};},
  });
  assert.equal(calls,1);assert.equal(result.answers[0].answer,'RESET_N');
});
