import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenEndpoint, toTokenizeRequest } from '../src/services/token-count.js';
import { toOpenAIRequest } from '../src/services/openai-upstream-adapter.js';

test('V0.29.77 tokenizer prompt matches inference adapter including tool-result images', () => {
  const req = { model: 'real', system: 'policy', max_tokens: 1024, stream: true,
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'img.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'page' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }], thinking: { type: 'enabled', budget_tokens: 2048 } };
  const before = JSON.stringify(req), options = { thinkingBudgetFormat: 'vllm' };
  const count = toTokenizeRequest(req, options), chat = toOpenAIRequest(req, options);
  assert.deepEqual(count.messages, chat.messages); assert.deepEqual(count.tools, chat.tools);
  assert.equal(count.messages.at(-1).content.find(part => part.type === 'image_url').image_url.url, 'data:image/png;base64,AAAA');
  assert.equal(count.thinking_token_budget, 2048); assert.equal(count.thinking_budget, undefined);
  assert.deepEqual(count.chat_template_kwargs, { enable_thinking: true });
  assert.equal(JSON.stringify(req), before); assert.equal(count.max_tokens, undefined); assert.equal(count.stream, undefined);
});
test('V0.29.77 thinking disabled is carried to tokenization exactly as inference', () => {
  const count = toTokenizeRequest({ model: 'real', messages: [{ role: 'user', content: 'x' }], thinking: { type: 'disabled' }, output_config: { effort: 'high' } });
  assert.equal(count.reasoning_effort, 'none'); assert.equal(count.thinking_budget, undefined);
});
test('V0.29.77 tokenizer endpoint preserves proxy prefix and configured query, never doubles v1', () => {
  assert.equal(tokenEndpoint('http://host/service/v1/chat/completions/?tenant=x', '/tokenize'), 'http://host/service/tokenize?tenant=x');
  assert.equal(tokenEndpoint('http://host/service/v1/', '/v1/tokenize'), 'http://host/service/v1/tokenize');
  assert.equal(tokenEndpoint('http://host/service/v1/messages', '/v1/messages/count_tokens'), 'http://host/service/v1/messages/count_tokens');
});
