import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectedVisualStore, buildDirectedPlanningRequest, parseDirectedPlanningResponse } from '../src/visual/directed-vision.js';

test('V0.29.47 directed visual store is request-local and planning is one image per forced tool call', () => {
  const store = new DirectedVisualStore();
  const first = store.register({ buffer: Buffer.from('a'), mediaType: 'image/png', width: 800, height: 600, filename: 'a.png' });
  const second = store.register({ buffer: Buffer.from('b'), mediaType: 'image/png', width: 900, height: 700, filename: 'b.png' });
  assert.equal(store.size, 2);

  const request = {
    model: 'm', stream: true,
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: [
      { type: 'text', text: `[PROXY_VISUAL_INPUT]\n${JSON.stringify({ asset_id: first.assetId, filename: 'a.png' })}` },
      { type: 'text', text: `[PROXY_VISUAL_INPUT]\n${JSON.stringify({ asset_id: second.assetId, filename: 'b.png' })}` },
    ] }],
  };

  const planning = buildDirectedPlanningRequest(request, first);
  const serialized = JSON.stringify(planning);
  assert.equal(planning.tools.length, 1);
  assert.equal(planning.tools[0].name, 'SubmitVisualPlan');
  assert.equal(planning.tool_choice.name, 'SubmitVisualPlan');
  assert.match(serialized, /a\.png/);
  assert.doesNotMatch(serialized, /b\.png/);
  assert.doesNotMatch(serialized, /"name":"Bash"/);

  const parsed = parseDirectedPlanningResponse({ content: [{ type: 'tool_use', id: 'p', name: 'SubmitVisualPlan', input: {
    objective: 'Inspect a.png.', questions: [{ id: 'q1', question: 'What is visible?' }],
  } }] }, first);
  assert.equal(parsed.asset_id, first.assetId);
  assert.equal(parsed.questions.length, 1);

  store.clear();
  assert.equal(store.size, 0);
});
