import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTED_VISUAL_CONTRACT_MARKER,
  DIRECTED_VISUAL_CONTRACT_TEXT,
  visualQueryToolDefinition,
} from '../src/visual/visual-query-tool.js';

test('V0.30.3 directed visual contract makes proxy_visual_query the required pixel-access path for declared visual inspection', () => {
  assert.equal(DIRECTED_VISUAL_CONTRACT_MARKER, 'VCC_PROXY_DIRECTED_VISUAL_V2');
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /VCC_VISUAL_SOURCE is a handle/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /pixels are not directly visible/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /need or intend to inspect/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /must call proxy_visual_query/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /do not claim.*visually inspected/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /DOM correctness/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /successful screenshot generation/i);
});

test('V0.30.3 proxy_visual_query description advertises itself as the only directed-image pixel inspection gateway', () => {
  const tool = visualQueryToolDefinition();
  assert.equal(tool.name, 'proxy_visual_query');
  assert.match(tool.description, /actual pixels/i);
  assert.match(tool.description, /only tool/i);
  assert.match(tool.description, /VCC_VISUAL_SOURCE/i);
  assert.match(tool.description, /visually inspect/i);
  assert.match(tool.description, /DOM/i);
  assert.match(tool.description, /file size/i);
});
