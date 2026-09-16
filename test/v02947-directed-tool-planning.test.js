import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectedVisualStore,
  buildDirectedPlanningRequest,
  parseDirectedPlanningResponse,
} from '../src/visual/directed-vision.js';

function makeAsset() {
  const store = new DirectedVisualStore();
  const asset = store.register({
    buffer: Buffer.from('fake-image'), mediaType: 'image/png', width: 1000, height: 700,
    receivedWidth: 1568, receivedHeight: 1098, filename: 'screen.png', sourceKind: 'read_image',
  });
  return { store, asset };
}

test('V0.29.47 planning exposes only forced SubmitVisualPlan and uses one-image input schema', () => {
  const { asset } = makeAsset();
  const request = {
    model: 'm', stream: true,
    tools: [
      { name: 'Bash', description: 'shell', input_schema: { type: 'object' } },
      { name: 'Read', description: 'read', input_schema: { type: 'object' } },
    ],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Check this screenshot.' }] }],
  };

  const planning = buildDirectedPlanningRequest(request, asset);
  assert.equal(planning.stream, false);
  assert.equal(planning.tools.length, 1);
  assert.equal(planning.tools[0].name, 'SubmitVisualPlan');
  assert.deepEqual(planning.tool_choice, {
    type: 'tool', name: 'SubmitVisualPlan', disable_parallel_tool_use: true,
  });
  assert.deepEqual(planning.tools[0].input_schema.required, ['objective', 'questions']);
  assert.equal('asset_id' in planning.tools[0].input_schema.properties, false);
  const serialized = JSON.stringify(planning);
  assert.match(serialized, /VCC_DIRECTED_VISUAL_PLANNING_V2/);
  assert.match(serialized, /SubmitVisualPlan/);
  assert.doesNotMatch(serialized, /"name":"Bash"|"name":"Read"|need_visual/);
});

test('V0.29.47 planning consumes SubmitVisualPlan tool_use input and ignores free text', () => {
  const { asset } = makeAsset();
  const parsed = parseDirectedPlanningResponse({
    content: [
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: 'This text is intentionally not JSON.' },
      { type: 'tool_use', id: 'plan-1', name: 'SubmitVisualPlan', input: {
        objective: 'Inspect the screenshot for visible problems.',
        questions: [
          { id: 'q1', question: 'What visible UI defect is present?' },
          { id: 'q2', question: 'Is any text clipped or unreadable?' },
        ],
      } },
    ],
    stop_reason: 'tool_use',
  }, asset);

  assert.equal(parsed.asset_id, asset.assetId);
  assert.equal(parsed.objective, 'Inspect the screenshot for visible problems.');
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[0].id, 'q1');
});

test('V0.29.47 planning rejects responses without exactly one SubmitVisualPlan tool_use', () => {
  const { asset } = makeAsset();
  assert.throws(
    () => parseDirectedPlanningResponse({ content: [{ type: 'text', text: '{"objective":"x"}' }] }, asset),
    (error) => error?.code === 'directed_planning_invalid',
  );
  assert.throws(
    () => parseDirectedPlanningResponse({ content: [
      { type: 'tool_use', id: '1', name: 'SubmitVisualPlan', input: { objective: 'x', questions: [{ id: 'q1', question: 'a?' }] } },
      { type: 'tool_use', id: '2', name: 'SubmitVisualPlan', input: { objective: 'y', questions: [{ id: 'q1', question: 'b?' }] } },
    ] }, asset),
    (error) => error?.code === 'directed_planning_invalid',
  );
});
