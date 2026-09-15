import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTED_VISUAL_CONTRACT_MARKER,
  DIRECTED_VISUAL_CONTRACT_TEXT,
  visualQueryToolDefinition,
} from '../src/visual/visual-query-tool.js';

test('V0.30.4 directed visual contract declares Proxy-managed automatic orchestration', () => {
  assert.equal(DIRECTED_VISUAL_CONTRACT_MARKER, 'VCC_PROXY_DIRECTED_VISUAL_V3');
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /metadata only/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /managed automatically by the Proxy/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /internal Main planner/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /Do not attempt to call proxy_visual_query/i);
  assert.match(DIRECTED_VISUAL_CONTRACT_TEXT, /visual-perception-v1/i);
});

test('V0.30.4 proxy_visual_query definition is explicitly Proxy-internal', () => {
  const tool = visualQueryToolDefinition();
  assert.equal(tool.name, 'proxy_visual_query');
  assert.match(tool.description, /Proxy-internal/i);
  assert.match(tool.description, /not exposed as a callable Main tool/i);
});
