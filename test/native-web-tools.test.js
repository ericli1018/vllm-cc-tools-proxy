import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNativeWebToolDefinition,
  normalizeNativeWebToolsRequest,
  createManagedWebPolicyEnforcer,
} from '../src/proxy/native-web-tools.js';

test('detects dated native web search and web fetch tool definitions', () => {
  assert.equal(isNativeWebToolDefinition({ type: 'web_search_20250305', name: 'web_search' }), true);
  assert.equal(isNativeWebToolDefinition({ type: 'web_search_20260318', name: 'web_search' }), true);
  assert.equal(isNativeWebToolDefinition({ type: 'web_fetch_20250910', name: 'web_fetch' }), true);
  assert.equal(isNativeWebToolDefinition({ type: 'web_fetch_20260318', name: 'web_fetch' }), true);
  assert.equal(isNativeWebToolDefinition({ name: 'web_search', input_schema: { type: 'object' } }), false);
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
