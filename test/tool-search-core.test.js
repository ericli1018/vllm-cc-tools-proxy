import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareLocalToolSearchRequest,
  executeLocalToolSearch,
  materializeLocalToolSearchTools,
  createLocalToolSearchResult,
} from '../src/proxy/tool-search.js';

function deferredTool(name, description, properties = {}) {
  return {
    name, description, defer_loading: true,
    input_schema: { type: 'object', properties },
  };
}

test('local regex ToolSearch searches names descriptions argument names and argument descriptions', () => {
  const prepared = prepareLocalToolSearchRequest({
    tools: [
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
      deferredTool('mcp__git__lookup', 'Repository helper', {
        needle: { type: 'string', description: 'Search source symbols and function names' },
      }),
      deferredTool('mcp__db__query', 'Run database query', {
        sql: { type: 'string', description: 'SQL statement' },
      }),
    ],
    messages: [],
  });
  const result = executeLocalToolSearch(prepared.state, {
    id: 's1', name: 'tool_search_tool_regex', input: { pattern: 'source.*function', limit: 5 },
  });
  assert.deepEqual(result.matches, ['mcp__git__lookup']);
  const request = materializeLocalToolSearchTools(prepared.request, prepared.state);
  assert.ok(request.tools.some((tool) => tool.name === 'mcp__git__lookup'));
  assert.ok(!request.tools.some((tool) => tool.name === 'mcp__db__query'));
});

test('invalid local regex returns a bounded tool_result error instead of throwing', () => {
  const prepared = prepareLocalToolSearchRequest({
    tools: [
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
      deferredTool('mcp__git__lookup', 'Repository helper'),
    ], messages: [],
  });
  const use = { id: 's-invalid', name: 'tool_search_tool_regex', input: { pattern: '(' } };
  const result = executeLocalToolSearch(prepared.state, use);
  assert.equal(result.error?.code, 'invalid_tool_input');
  assert.deepEqual(result.matches, []);
  const block = createLocalToolSearchResult(use, result);
  assert.equal(block.type, 'tool_result');
  assert.equal(block.is_error, true);
  assert.match(block.content, /invalid_tool_input/);
});

test('local ToolSearch disables itself after three internal search rounds while preserving materialized tools', () => {
  const prepared = prepareLocalToolSearchRequest({
    tools: [
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      deferredTool('mcp__github__search_code', 'Search GitHub repository source code'),
    ], messages: [],
  });
  const first = executeLocalToolSearch(prepared.state, { id: 's1', name: 'tool_search_tool_bm25', input: { query: 'github code' } });
  const second = executeLocalToolSearch(prepared.state, { id: 's2', name: 'tool_search_tool_bm25', input: { query: 'github code' } });
  const third = executeLocalToolSearch(prepared.state, { id: 's3', name: 'tool_search_tool_bm25', input: { query: 'github code' } });
  assert.equal(first.exhausted, false);
  assert.equal(second.exhausted, false);
  assert.equal(third.exhausted, true);
  const request = materializeLocalToolSearchTools(prepared.request, prepared.state, { disableSearch: true });
  assert.ok(!request.tools.some((tool) => tool.name === 'tool_search_tool_bm25'));
  assert.ok(request.tools.some((tool) => tool.name === 'mcp__github__search_code'));
});

test('local ToolSearch hard-stops calls beyond the three-round budget even inside one model response', () => {
  const prepared = prepareLocalToolSearchRequest({
    tools: [
      { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      deferredTool('mcp__github__search_code', 'Search GitHub repository source code'),
    ], messages: [],
  });
  for (let round = 1; round <= 3; round += 1) {
    const result = executeLocalToolSearch(prepared.state, {
      id: `s${round}`,
      name: 'tool_search_tool_bm25',
      input: { query: 'github code' },
    });
    assert.equal(result.error, null);
  }
  const fourth = executeLocalToolSearch(prepared.state, {
    id: 's4',
    name: 'tool_search_tool_bm25',
    input: { query: 'github code' },
  });
  assert.equal(fourth.error?.code, 'tool_search_budget_exhausted');
  assert.equal(fourth.round, 3);
  assert.equal(fourth.exhausted, true);
  assert.deepEqual(fourth.matches, []);
});
