import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNativeWebToolDefinition,
  normalizeNativeWebToolsRequest,
  createManagedWebPolicyEnforcer,
  normalizeNativeWebToolResponse,
  containsNativeWebResponseBlocks,
  createServerWebToolUse,
  createServerWebToolResult,
  sanitizeCompletedServerWebHistory,
  detectServerWebUiDeclaration,
} from '../src/proxy/native-web-tools.js';

test('detects dated native web search and web fetch tool definitions', () => {
  assert.equal(isNativeWebToolDefinition({ type: 'web_search_20250305', name: 'web_search' }), true);
  assert.equal(isNativeWebToolDefinition({ type: 'web_search_20260318', name: 'web_search' }), true);
  assert.equal(isNativeWebToolDefinition({ type: 'web_fetch_20250910', name: 'web_fetch' }), true);
  assert.equal(isNativeWebToolDefinition({ type: 'web_fetch_20260318', name: 'web_fetch' }), true);
  assert.equal(isNativeWebToolDefinition({ name: 'web_search', input_schema: { type: 'object' } }), false);
});

test('V0.2.21 detects explicit built-in web declarations for native Claude Code UI without matching third-party tools', () => {
  assert.deepEqual(detectServerWebUiDeclaration({ tools: [{ type: 'web_search_20260318', name: 'web_search' }] }), {
    eligible: true, search: true, fetch: false, native_count: 1, alias_count: 0,
  });
  assert.deepEqual(detectServerWebUiDeclaration({ tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }, { name: 'web_fetch', input_schema: { type: 'object' } }] }), {
    eligible: true, search: true, fetch: true, native_count: 0, alias_count: 2,
  });
  assert.deepEqual(detectServerWebUiDeclaration({ tools: [{ name: 'mcp__searxng__web_search' }, { name: 'company_web_fetch_v2' }] }), {
    eligible: false, search: false, fetch: false, native_count: 0, alias_count: 0,
  });
});

test('normalizes native web tools into custom schemas and extracts local policy', () => {
  const original = {
    model: 'm',
    tools: [
      {
        type: 'web_search_20260318', name: 'web_search', max_uses: 8,
        allowed_domains: ['example.com/docs'],
        user_location: { type: 'approximate', country: 'TW', timezone: 'Asia/Taipei' },
      },
      {
        type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3,
        blocked_domains: ['private.example.com'], max_content_tokens: 1234,
        citations: { enabled: true },
      },
      { name: 'Read', description: 'read', input_schema: { type: 'object' } },
    ],
    messages: [],
  };

  const result = normalizeNativeWebToolsRequest(original);
  assert.equal(result.changed, true);
  assert.equal(result.nativeToolCount, 2);
  assert.notEqual(result.request, original);
  assert.deepEqual(result.request.tools.map((tool) => tool.name), ['web_search', 'web_fetch', 'Read']);

  const search = result.request.tools[0];
  assert.equal(search.type, undefined);
  assert.equal(search.max_uses, undefined);
  assert.deepEqual(search.input_schema.required, ['query']);
  assert.equal(search.input_schema.additionalProperties, false);

  const fetch = result.request.tools[1];
  assert.equal(fetch.type, undefined);
  assert.equal(fetch.max_content_tokens, undefined);
  assert.deepEqual(fetch.input_schema.required, ['url']);
  assert.ok(fetch.input_schema.properties.prompt);

  assert.deepEqual(result.policies.WebSearch, {
    nativeType: 'web_search_20260318',
    maxUses: 8,
    allowedDomains: ['example.com/docs'],
    blockedDomains: [],
    userLocation: { type: 'approximate', country: 'TW', timezone: 'Asia/Taipei' },
    maxContentTokens: null,
    citationsEnabled: false,
    unsupportedFields: [],
  });
  assert.deepEqual(result.policies.WebFetch, {
    nativeType: 'web_fetch_20250910',
    maxUses: 3,
    allowedDomains: [],
    blockedDomains: ['private.example.com'],
    userLocation: null,
    maxContentTokens: 1234,
    citationsEnabled: true,
    unsupportedFields: [],
  });
});

test('leaves ordinary custom and non-web tools unchanged', () => {
  const request = {
    tools: [
      { name: 'web_search', description: 'custom', input_schema: { type: 'object' } },
      { name: 'WebFetch', description: 'custom', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'run', input_schema: { type: 'object' } },
    ],
    messages: [],
  };
  const result = normalizeNativeWebToolsRequest(request);
  assert.equal(result.changed, false);
  assert.equal(result.request, request);
  assert.deepEqual(result.policies, {});
});

test('does not emit a duplicate custom tool when native and custom aliases coexist', () => {
  const result = normalizeNativeWebToolsRequest({
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
      { name: 'web_search', description: 'existing', input_schema: { type: 'object' } },
    ],
    messages: [],
  });
  assert.equal(result.request.tools.length, 1);
  assert.equal(result.request.tools[0].description, 'existing');
  assert.equal(result.policies.WebSearch.maxUses, 2);
});

test('rejects conflicting allowed and blocked domain policy', () => {
  assert.throws(() => normalizeNativeWebToolsRequest({
    tools: [{
      type: 'web_fetch_20250910', name: 'web_fetch',
      allowed_domains: ['example.com'], blocked_domains: ['bad.example.com'],
    }],
    messages: [],
  }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_native_web_tool_policy');
    return true;
  });
});

test('policy enforcer counts failed or successful attempts and blocks uses above max_uses', () => {
  const enforcer = createManagedWebPolicyEnforcer({
    WebSearch: { maxUses: 1 },
  });
  assert.deepEqual(enforcer.consume('web_search'), { maxUses: 1 });
  assert.throws(() => enforcer.consume('WebSearch'), (error) => {
    assert.equal(error.code, 'max_uses_exceeded');
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, { tool: 'WebSearch', max_uses: 1, attempted_use: 2 });
    return true;
  });
});


test('normalizes response-side native web server calls and removes native result blocks', () => {
  const original = {
    id: 'm1',
    content: [
      { type: 'thinking', thinking: 'need evidence' },
      { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: { query: 'libuv openssl' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv-1', content: [{ type: 'web_search_result', url: 'https://example.com' }] },
      { type: 'server_tool_use', id: 'srv-2', name: 'web_fetch', input: { url: 'https://example.com' } },
      { type: 'web_fetch_tool_result', tool_use_id: 'srv-2', content: { type: 'web_fetch_result', url: 'https://example.com' } },
    ],
    stop_reason: 'pause_turn',
  };

  const result = normalizeNativeWebToolResponse(original);
  assert.equal(result.changed, true);
  assert.equal(result.serverToolUseCount, 2);
  assert.equal(result.strippedResultCount, 2);
  assert.deepEqual(result.response.content, [
    { type: 'thinking', thinking: 'need evidence' },
    { type: 'tool_use', id: 'srv-1', name: 'web_search', input: { query: 'libuv openssl' } },
    { type: 'tool_use', id: 'srv-2', name: 'web_fetch', input: { url: 'https://example.com' } },
  ]);
  assert.equal(result.response.stop_reason, 'tool_use');
  assert.equal(containsNativeWebResponseBlocks(result.response), false);
  assert.equal(containsNativeWebResponseBlocks(original), true);
});

test('leaves unrelated server tools and ordinary tool blocks unchanged', () => {
  const original = {
    content: [
      { type: 'server_tool_use', id: 'x1', name: 'code_execution', input: {} },
      { type: 'tool_use', id: 'x2', name: 'Read', input: { file_path: '/x' } },
    ],
    stop_reason: 'tool_use',
  };
  const result = normalizeNativeWebToolResponse(original);
  assert.equal(result.changed, false);
  assert.equal(result.response, original);
});

test('V0.2.20 builds Anthropic-compatible server web use and result blocks', () => {
  const searchUse = createServerWebToolUse({ id: 'toolu_local_search', name: 'web_search_20260318', input: { query: 'latest news' } });
  assert.match(searchUse.id, /^srvtoolu_/);
  assert.deepEqual(searchUse.block, {
    type: 'server_tool_use', id: searchUse.id, name: 'web_search', input: { query: 'latest news' },
  });
  const searchResult = createServerWebToolResult('WebSearch', searchUse.id, {
    query: 'latest news', result_count: 1,
    results: [{ title: 'A', url: 'https://example.com/a', published_date: '2026-08-07', snippet: 'x' }],
  });
  assert.equal(searchResult.type, 'web_search_tool_result');
  assert.equal(searchResult.tool_use_id, searchUse.id);
  assert.equal(searchResult.content.length, 1);
  assert.deepEqual({ ...searchResult.content[0], encrypted_content: '<opaque>' }, {
    type: 'web_search_result', title: 'A', url: 'https://example.com/a',
    encrypted_content: '<opaque>', page_age: '2026-08-07',
  });
  assert.match(searchResult.content[0].encrypted_content, /^vcc_local_[A-Za-z0-9_-]+$/);

  const fetchUse = createServerWebToolUse({ id: 'toolu_local_fetch', name: 'WebFetch', input: { url: 'https://example.com/a' } });
  const fetchResult = createServerWebToolResult('WebFetch', fetchUse.id, {
    final_url: 'https://example.com/a', title: 'Article', result: 'Processed body', retrieved_at: '2026-08-07T00:00:00Z',
  });
  assert.equal(fetchResult.type, 'web_fetch_tool_result');
  assert.equal(fetchResult.tool_use_id, fetchUse.id);
  assert.equal(fetchResult.content.type, 'web_fetch_result');
  assert.equal(fetchResult.content.url, 'https://example.com/a');
  assert.equal(fetchResult.content.content.type, 'document');
  assert.equal(fetchResult.content.content.source.data, 'Processed body');
});

test('V0.2.21 synthetic web fetch result always carries response-side title and retrieved_at metadata', () => {
  const result = createServerWebToolResult('WebFetch', 'srvtoolu_fetch_meta', {
    final_url: 'https://example.com/article', result: 'body',
  });
  assert.equal(result.content.type, 'web_fetch_result');
  assert.equal(result.content.content.type, 'document');
  assert.equal(result.content.content.title, 'example.com');
  assert.match(result.content.retrieved_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('V0.2.21 synthetic search results keep strict response metadata even when source age is unknown', () => {
  const result = createServerWebToolResult('WebSearch', 'srvtoolu_unknown_age', {
    results: [{ title: 'Untimed', url: 'https://example.com/no-age' }],
  });
  assert.equal(result.content[0].page_age, null);
  assert.match(result.content[0].encrypted_content, /^vcc_local_[A-Za-z0-9_-]+$/);
});

test('V0.2.20 builds safe server web error blocks', () => {
  const search = createServerWebToolResult('WebSearch', 'srvtoolu_s', null, { code: 'max_uses_exceeded' });
  assert.deepEqual(search, {
    type: 'web_search_tool_result', tool_use_id: 'srvtoolu_s',
    content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
  });
  const fetch = createServerWebToolResult('WebFetch', 'srvtoolu_f', null, { code: 'blocked_fetch_target' });
  assert.deepEqual(fetch, {
    type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_f',
    content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' },
  });
});


test('V0.2.20 converts completed server web lifecycle history into bounded model-readable evidence', () => {
  const original = [
    { role: 'assistant', content: [
      { type: 'server_tool_use', id: 'srvtoolu_search_done', name: 'web_search', input: { query: 'tls docs' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_search_done', content: [
        { type: 'web_search_result', title: 'TLS Docs', url: 'https://example.com/tls', page_age: '2026-08-07' },
      ] },
      { type: 'text', text: 'Earlier final answer.' },
    ] },
    { role: 'user', content: 'Follow up.' },
  ];
  const result = sanitizeCompletedServerWebHistory(original);
  assert.equal(result.changed, true);
  assert.equal(result.completed_count, 1);
  assert.doesNotMatch(JSON.stringify(result.messages), /server_tool_use|web_search_tool_result/);
  assert.match(JSON.stringify(result.messages), /TLS Docs/);
  assert.match(JSON.stringify(result.messages), /https:\/\/example\.com\/tls/);
  assert.match(JSON.stringify(result.messages), /Earlier final answer/);
});

test('V0.2.20 keeps unresolved server web use intact for mixed-tool continuation', () => {
  const original = [{ role: 'assistant', content: [
    { type: 'server_tool_use', id: 'srvtoolu_pending', name: 'web_search', input: { query: 'tls docs' } },
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/project/a.c' } },
  ] }];
  const result = sanitizeCompletedServerWebHistory(original);
  assert.equal(result.changed, false);
  assert.deepEqual(result.messages, original);
});
