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
