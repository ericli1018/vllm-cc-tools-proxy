import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebToolDiagnosticController } from '../src/proxy/web-tool-diagnostic.js';

test('diagnostic controller gives Search and Fetch independent passthrough quotas and correlates returned tool results', () => {
  const controller = createWebToolDiagnosticController({
    enabled: true,
    searchPassthroughCount: 1,
    fetchPassthroughCount: 1,
  });
  const search = controller.decide({ toolUses: [
    { type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'q' } },
  ] });
  assert.equal(search.passthrough, true);
  assert.deepEqual(search.tool_ids, ['search-1']);
  assert.equal(controller.snapshot().search_remaining, 0);
  assert.equal(controller.snapshot().fetch_remaining, 1);

  const secondSearch = controller.decide({ toolUses: [
    { type: 'tool_use', id: 'search-2', name: 'web_search', input: { query: 'q2' } },
  ] });
  assert.equal(secondSearch.passthrough, false);

  const fetch = controller.decide({ toolUses: [
    { type: 'tool_use', id: 'fetch-1', name: 'web_fetch_20260318', input: { url: 'https://example.com' } },
  ] });
  assert.equal(fetch.passthrough, true);
  assert.equal(controller.snapshot().fetch_remaining, 0);

  const returned = controller.findReturnedToolResults([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'q' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'search-1', content: 'search output' },
      { type: 'tool_result', tool_use_id: 'other', content: 'ignore' },
    ] },
  ]);
  assert.equal(returned.length, 1);
  assert.equal(returned[0].tool_use_id, 'search-1');
  assert.equal(returned[0].canonical, 'WebSearch');
});

test('diagnostic controller refuses partial web passthrough when one managed call lacks quota', () => {
  const controller = createWebToolDiagnosticController({
    enabled: true,
    searchPassthroughCount: 1,
    fetchPassthroughCount: 0,
  });
  const decision = controller.decide({ toolUses: [
    { type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'q' } },
    { type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { url: 'https://example.com' } },
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/x' } },
  ] });
  assert.equal(decision.passthrough, false);
  assert.equal(controller.snapshot().search_remaining, 1);
});
