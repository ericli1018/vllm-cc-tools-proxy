import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectedVisualStore,
  buildDirectedPlanningRequest,
  parseDirectedPlanningResponse,
  executeDirectedPerception,
  injectDirectedPerceptionEvidence,
} from '../src/visual/directed-vision.js';

function makeStore() {
  const store = new DirectedVisualStore();
  const asset = store.register({
    buffer: Buffer.from('fake-image'), mediaType: 'image/png', width: 1000, height: 700,
    receivedWidth: 1568, receivedHeight: 1098, filename: 'screen.png', sourceKind: 'read_image',
  });
  return { store, asset };
}

test('V0.29.47 planning is forced SubmitVisualPlan tool-use and exposes no Claude Code tools', () => {
  const { store, asset } = makeStore();
  const request = {
    model: 'm', stream: true,
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [{ type: 'text', text: `[PROXY_VISUAL_INPUT]\n${JSON.stringify({ asset_id: asset.assetId, width: 1000, height: 700 })}` }] }],
  };
  const planning = buildDirectedPlanningRequest(request, asset);
  assert.equal(planning.stream, false);
  assert.equal(planning.tools.length, 1);
  assert.equal(planning.tools[0].name, 'SubmitVisualPlan');
  assert.equal(planning.tool_choice.type, 'tool');
  assert.equal(planning.tool_choice.name, 'SubmitVisualPlan');
  assert.equal(planning.tool_choice.disable_parallel_tool_use, true);
  const serialized = JSON.stringify(planning);
  assert.match(serialized, /VCC_DIRECTED_VISUAL_PLANNING_V2/);
  assert.doesNotMatch(serialized, /VisualInspect|need_visual|\"name\":\"Bash\"/);

  const parsed = parseDirectedPlanningResponse({
    content: [{ type: 'tool_use', id: 'plan-1', name: 'SubmitVisualPlan', input: {
      objective: 'Inspect the screenshot for visible problems.',
      questions: [{ id: 'q1', question: 'What visible UI defect is present?' }],
    } }],
    stop_reason: 'tool_use',
  }, asset);
  assert.equal(parsed.asset_id, asset.assetId);
  assert.equal(parsed.questions.length, 1);
});

test('V0.29.46 directed perception calls Vision once and preserves follow-up evidence for Main', async () => {
  const { store, asset } = makeStore();
  let calls = 0;
  const result = await executeDirectedPerception(store, {
    asset_id: asset.assetId,
    objective: 'Read the visible error state.',
    questions: [{ id: 'q1', question: 'What error text is visible?' }],
  }, {
    vllmVisionUrl: 'http://vision:8000', vllmVisionModel: 'vision-model', vllmVisionProvider: 'vllm',
    vllmVisionThink: false, vllmVisionTimeoutMs: 30000, limits: { maxOutputChars: 65536 },
  }, undefined, {
    fetchJsonImpl: async () => {
      calls += 1;
      return { choices: [{ message: { content: JSON.stringify({
        schema: 'visual_perception_v1', asset_id: asset.assetId, status: 'partial',
        answers: [{ question_id: 'q1', status: 'unresolved', answer: null, evidence: [], uncertainty: 'text too small' }],
        follow_up_regions: [{ bbox: [600, 200, 950, 500], target: 'error dialog', reason: 'text_too_small' }],
      }) } }] };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.follow_up_regions[0].bbox, [600, 200, 950, 500]);
});

test('V0.29.46 final Main context contains current evidence only and no visual tool or historical marker', () => {
  const messages = [
    { role: 'user', content: [
      null,
      { type: 'text', text: '[PROXY_VISUAL_INPUT]\n{"asset_id":"visual-1","filename":"screen.png"}' },
    ].filter(Boolean) },
  ];
  const output = injectDirectedPerceptionEvidence(messages, new Map([['visual-1', {
    plan: { asset_id: 'visual-1', objective: 'Inspect UI', questions: [{ id: 'q1', question: 'Visible defect?' }] },
    result: { schema: 'visual_perception_v1', asset_id: 'visual-1', status: 'complete', answers: [{ question_id: 'q1', status: 'answered', answer: 'No overlap', evidence: [], uncertainty: '' }], follow_up_regions: [] },
  }]]));
  const serialized = JSON.stringify(output);
  assert.match(serialized, /PROXY_VISUAL_EVIDENCE/);
  assert.match(serialized, /No overlap/);
  assert.doesNotMatch(serialized, /PROXY_VISUAL_INPUT/);
  assert.doesNotMatch(serialized, /PROXY_HISTORICAL_VISUAL/);
  assert.doesNotMatch(serialized, /VisualInspect/);
});
