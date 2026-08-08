import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFinalLanguageGate,
  classifyFinalLanguage,
} from '../src/proxy/final-language-gate.js';

test('V0.2.26.4 language classifier repairs clear English for zh-TW but accepts mixed technical Traditional Chinese', () => {
  assert.equal(
    classifyFinalLanguage('The request is complete. The proxy returned the final response successfully.', 'zh-TW').decision,
    'repair',
  );
  assert.equal(
    classifyFinalLanguage('目前 vLLM 的 request 已完成，response 會直接交回 Claude Code。', 'zh-TW').decision,
    'compliant',
  );
  assert.equal(
    classifyFinalLanguage('```js\nconst response = await fetch(url);\n```', 'zh-TW').decision,
    'uncertain',
  );
});

test('V0.2.26.4 final language gate never rewrites tool-use or intermediate responses', async () => {
  let calls = 0;
  const original = {
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'I need to search first.' },
      { type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'x' } },
    ],
  };
  const result = await applyFinalLanguageGate(original, {
    locale: 'zh-TW',
    rewriteExternal: async () => { calls += 1; return ['不應執行']; },
    rewriteBase: async () => { calls += 1; return ['不應執行']; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.response, original);
  assert.equal(result.action, 'bypass_non_final');
});

test('V0.2.26.4 final language gate rewrites only final text blocks with the external processor', async () => {
  const original = {
    id: 'msg-1', role: 'assistant', stop_reason: 'end_turn', usage: { output_tokens: 12 },
    content: [
      { type: 'thinking', thinking: 'private reasoning remains untouched' },
      { type: 'text', text: 'The request is complete.' },
      { type: 'text', text: 'The result is ready.' },
    ],
  };
  const seen = [];
  const result = await applyFinalLanguageGate(original, {
    locale: 'zh-TW',
    rewriteExternal: async (segments, locale) => {
      seen.push({ segments, locale });
      return ['請求已完成。', '結果已就緒。'];
    },
    rewriteBase: async () => { throw new Error('base should not run'); },
  });
  assert.deepEqual(seen, [{ segments: ['The request is complete.', 'The result is ready.'], locale: 'zh-TW' }]);
  assert.equal(result.action, 'rewritten');
  assert.equal(result.backend, 'external');
  assert.equal(result.response.content[0].thinking, original.content[0].thinking);
  assert.equal(result.response.content[1].text, '請求已完成。');
  assert.equal(result.response.content[2].text, '結果已就緒。');
  assert.deepEqual(original.content.map((block) => block.text || block.thinking), [
    'private reasoning remains untouched', 'The request is complete.', 'The result is ready.',
  ]);
});

test('V0.2.26.4 external repair failure falls back to isolated Base repair', async () => {
  const events = [];
  const result = await applyFinalLanguageGate({
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'The answer is ready for the user.' }],
  }, {
    locale: 'zh-TW',
    rewriteExternal: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); },
    rewriteBase: async (segments) => [`答案已準備完成：${segments.length}`],
    onEvent: async (event, fields) => events.push({ event, ...fields }),
  });
  assert.equal(result.backend, 'base');
  assert.equal(result.response.content[0].text, '答案已準備完成：1');
  assert.ok(events.some((entry) => entry.event === 'final_language_repair_failed' && entry.backend === 'external' && entry.fallback === 'base'));
});

test('V0.2.26.4 missing external processor uses Base repair directly', async () => {
  let baseCalls = 0;
  const result = await applyFinalLanguageGate({
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'This answer is in English.' }],
  }, {
    locale: 'zh-TW',
    rewriteBase: async () => { baseCalls += 1; return ['這份回答已轉為繁體中文。']; },
  });
  assert.equal(baseCalls, 1);
  assert.equal(result.backend, 'base');
  assert.equal(result.response.content[0].text, '這份回答已轉為繁體中文。');
});

test('V0.2.26.4 all repair failures preserve the original successful Laguna answer', async () => {
  const original = {
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'The original answer must still be delivered.' }],
  };
  const result = await applyFinalLanguageGate(original, {
    locale: 'zh-TW',
    rewriteExternal: async () => { throw new Error('external failed'); },
    rewriteBase: async () => { throw new Error('base failed'); },
  });
  assert.equal(result.action, 'fallback_original');
  assert.deepEqual(result.response, original);
});
