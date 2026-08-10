import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextCompactRequest,
  contextCompactEndpoint,
  normalizeCompactMessages,
  parseContextCompactResponse,
} from '../src/services/context-compact-client.js';

const anthropic = {
  system: 'system policy',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'private' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
  ],
};

test('V0.2.28.10 normalizes Anthropic compact history without private thinking', () => {
  const messages = normalizeCompactMessages(anthropic);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'system policy');
  assert.match(messages[2].content, /\[Tool Use\]/);
  assert.match(messages[3].content, /\[Tool Result\]/);
  assert.doesNotMatch(JSON.stringify(messages), /private/);
});

test('V0.2.28.10 vLLM compact provider uses OpenAI chat and vLLM thinking kwargs', () => {
  assert.equal(contextCompactEndpoint('http://vllm:8000', 'vllm'), 'http://vllm:8000/v1/chat/completions');
  const body = buildContextCompactRequest(anthropic, {
    provider: 'vllm', model: 'qwen3.6-27b-cc', think: false,
  });
  assert.equal(body.model, 'qwen3.6-27b-cc');
  assert.equal(body.stream, false);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(body.chat_template_kwargs.preserve_thinking, false);
  assert.equal('think' in body, false);
  assert.equal('reasoning_effort' in body, false);
});

test('V0.2.28.10 Ollama compact provider uses native api/chat and native think flag', () => {
  assert.equal(contextCompactEndpoint('http://ollama:11434', 'ollama'), 'http://ollama:11434/api/chat');
  const body = buildContextCompactRequest(anthropic, {
    provider: 'ollama', model: 'qwen3.6:27b-q4_K_M-cc', think: false,
  });
  assert.equal(body.model, 'qwen3.6:27b-q4_K_M-cc');
  assert.equal(body.think, false);
  assert.equal('chat_template_kwargs' in body, false);
  assert.equal(body.options.num_predict, 16384);
});

test('V0.2.28.10 compact parser discards backend thinking but preserves literal analysis summary text', () => {
  assert.equal(parseContextCompactResponse({ choices: [{ message: {
    content: '<think>backend private</think><analysis>compact analysis</analysis>\nSUMMARY',
    reasoning_content: 'private',
  } }] }, 'vllm'), '<analysis>compact analysis</analysis>\nSUMMARY');
  assert.equal(parseContextCompactResponse({ message: {
    content: '<analysis>compact analysis</analysis>\nSUMMARY', thinking: 'private',
  } }, 'ollama'), '<analysis>compact analysis</analysis>\nSUMMARY');
});

test('V0.2.28.10 THINK=true remains provider-specific', () => {
  const vllm = buildContextCompactRequest(anthropic, { provider: 'vllm', model: 'm', think: true });
  const ollama = buildContextCompactRequest(anthropic, { provider: 'ollama', model: 'm', think: true });
  assert.equal(vllm.chat_template_kwargs.enable_thinking, true);
  assert.equal(vllm.chat_template_kwargs.preserve_thinking, false);
  assert.equal('think' in vllm, false);
  assert.equal(ollama.think, true);
  assert.equal('chat_template_kwargs' in ollama, false);
});
