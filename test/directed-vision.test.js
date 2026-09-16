import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectedVisualStore,
  directedVisualToolDefinition,
  executeDirectedVisualInspect,
} from '../src/visual/directed-vision.js';

function makeStore() {
  const store = new DirectedVisualStore();
  const asset = store.register({
    buffer: Buffer.from('fake-image-bytes'),
    mediaType: 'image/png', width: 1200, height: 675,
    receivedWidth: 1568, receivedHeight: 882,
    filename: 'screen.png', sourceRef: '/workspace/screen.png', sourceKind: 'read_image',
  });
  return { store, asset };
}

const config = {
  vllmVisionUrl: 'http://vision:8000',
  vllmVisionModel: 'vision-model',
  vllmVisionApiKey: 'vision-secret',
  vllmVisionProvider: 'vllm',
  vllmVisionThink: false,
  vllmVisionTimeoutMs: 30000,
  limits: { maxOutputChars: 100000 },
};

test('V0.29.44 VisualInspect tool schema exposes task-specific questions and no crop input', () => {
  const tool = directedVisualToolDefinition();
  assert.equal(tool.name, 'VisualInspect');
  assert.deepEqual(tool.input_schema.required, ['asset_id', 'objective', 'questions']);
  assert.equal(tool.input_schema.properties.questions.maxItems, 8);
  assert.equal('region' in tool.input_schema.properties, false);
  assert.doesNotMatch(JSON.stringify(tool), /crop_image|request_image_crop/);
});

test('V0.29.44 VisualInspect performs one single-pass Vision request and returns validated perception JSON', async () => {
  const { store, asset } = makeStore();
  let calls = 0;
  let observedUrl = '';
  let observedOptions = null;
  const payload = {
    choices: [{ message: { content: JSON.stringify({
      schema: 'visual_perception_v1',
      asset_id: asset.assetId,
      status: 'partial',
      answers: [
        {
          question_id: 'q1', status: 'answered', answer: 'Connection refused',
          evidence: [{ kind: 'text', value: 'Connection refused', region: [600, 380, 910, 520] }],
          uncertainty: '',
        },
        {
          question_id: 'q2', status: 'unresolved', answer: null, evidence: [],
          uncertainty: 'The small status text is not readable at this resolution.',
        },
      ],
      follow_up_regions: [
        { bbox: [690, 80, 980, 240], target: 'connection status text', reason: 'text_too_small' },
      ],
    }) } }],
  };
  const result = await executeDirectedVisualInspect(store, {
    asset_id: asset.assetId,
    objective: 'Determine the visible connection failure state.',
    questions: [
      { id: 'q1', question: 'What exact error text is visible?' },
      { id: 'q2', question: 'What is the connection state?' },
    ],
  }, config, undefined, {
    fetchJsonImpl: async (url, options) => {
      calls += 1;
      observedUrl = String(url);
      observedOptions = options;
      return payload;
    },
  });

  assert.equal(calls, 1);
  assert.equal(observedUrl, 'http://vision:8000/v1/chat/completions');
  const body = JSON.parse(observedOptions.body);
  assert.equal(body.model, 'vision-model');
  assert.equal(body.parallel_tool_calls, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.match(body.messages[0].content, /visual perception sensor/i);
  assert.match(JSON.stringify(body.messages[1]), /What exact error text is visible/);
  assert.match(JSON.stringify(body.messages[1]), /data:image\/png;base64/);
  assert.equal(result.schema, 'visual_perception_v1');
  assert.equal(result.asset_id, asset.assetId);
  assert.equal(result.status, 'partial');
  assert.equal(result.answers[1].status, 'unresolved');
  assert.deepEqual(result.follow_up_regions[0].bbox, [690, 80, 980, 240]);
});

test('V0.29.44 VisualInspect rejects malformed or incomplete JSON without semantic recovery retry', async () => {
  const { store, asset } = makeStore();
  let calls = 0;
  await assert.rejects(() => executeDirectedVisualInspect(store, {
    asset_id: asset.assetId,
    objective: 'Read visible error.',
    questions: [{ id: 'q1', question: 'What error is visible?' }],
  }, config, undefined, {
    fetchJsonImpl: async () => {
      calls += 1;
      return { choices: [{ message: { content: '{"schema":"visual_perception_v1"' } }] };
    },
  }), (error) => error?.code === 'directed_vision_invalid_json');
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(() => executeDirectedVisualInspect(store, {
    asset_id: asset.assetId,
    objective: 'Read visible error.',
    questions: [{ id: 'q1', question: 'What error is visible?' }],
  }, config, undefined, {
    fetchJsonImpl: async () => {
      calls += 1;
      return { choices: [{ message: { content: JSON.stringify({
        schema: 'visual_perception_v1', asset_id: asset.assetId, status: 'complete', answers: [], follow_up_regions: [],
      }) } }] };
    },
  }), (error) => error?.code === 'directed_vision_schema_invalid');
  assert.equal(calls, 1);
});
