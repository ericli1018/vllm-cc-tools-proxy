import test from 'node:test';
import assert from 'node:assert/strict';
import { injectDirectedPerceptionEvidence } from '../src/visual/directed-vision.js';

test('V0.29.48 final Main receives only structured perception result, not repeated planning request', () => {
  const messages = [{
    role: 'user',
    content: [{
      type: 'text',
      text: '[PROXY_VISUAL_INPUT]\n{"asset_id":"visual-1","filename":"screen.png"}\ncurrent image',
    }],
  }];

  const evidenceByAssetId = new Map([['visual-1', {
    plan: {
      asset_id: 'visual-1',
      objective: 'Inspect the screenshot for visible layout problems.',
      questions: [{ id: 'q1', question: 'Is any text clipped?' }],
    },
    result: {
      schema: 'visual_perception_v1',
      asset_id: 'visual-1',
      status: 'complete',
      answers: [{
        question_id: 'q1',
        status: 'answered',
        answer: 'No text is visibly clipped.',
        evidence: [{ kind: 'state', value: 'All visible text fits within its containers.' }],
        uncertainty: '',
      }],
      follow_up_regions: [],
    },
  }]]);

  const injected = injectDirectedPerceptionEvidence(messages, evidenceByAssetId);
  const text = injected[0].content[0].text;
  assert.match(text, /^\[PROXY_VISUAL_EVIDENCE\]\n/);
  const jsonLine = text.split('\n')[1];
  const payload = JSON.parse(jsonLine);

  assert.equal(payload.schema, 'visual_perception_v1');
  assert.equal(payload.asset_id, 'visual-1');
  assert.equal(payload.status, 'complete');
  assert.equal(payload.answers[0].question_id, 'q1');
  assert.deepEqual(payload.follow_up_regions, []);
  assert.equal('perception_request' in payload, false);
  assert.equal('perception_result' in payload, false);

  assert.doesNotMatch(text, /Inspect the screenshot for visible layout problems/);
  assert.doesNotMatch(text, /Is any text clipped\?/);
});
