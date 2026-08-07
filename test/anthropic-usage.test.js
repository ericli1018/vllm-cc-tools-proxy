import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnthropicUsage,
  usageFromTokenCount,
  totalAnthropicInputTokens,
} from '../src/proxy/anthropic-usage.js';

test('normalizeAnthropicUsage preserves Anthropic token and server-tool counters', () => {
  assert.deepEqual(normalizeAnthropicUsage({
    input_tokens: 180000,
    cache_creation_input_tokens: 1200,
    cache_read_input_tokens: 3400,
    output_tokens: 55,
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 1, invalid: -1 },
    ignored: 'value',
  }), {
    input_tokens: 180000,
    cache_creation_input_tokens: 1200,
    cache_read_input_tokens: 3400,
    output_tokens: 55,
    server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
  });
});

test('usageFromTokenCount creates a valid streaming message_start usage object', () => {
  const usage = usageFromTokenCount({ input_tokens: 197500 });
  assert.deepEqual(usage, {
    input_tokens: 197500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  });
  assert.equal(totalAnthropicInputTokens(usage), 197500);
});
