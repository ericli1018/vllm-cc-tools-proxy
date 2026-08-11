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

test('V0.2.26.5 short explicit Simplified/Traditional Chinese is discriminated for zh-TW and zh-CN', () => {
  const simplified = classifyFinalLanguage('这是测试。', 'zh-TW');
  assert.equal(simplified.decision, 'repair');
  assert.equal(simplified.detected, 'zh-CN');

  const traditional = classifyFinalLanguage('這是測試。', 'zh-CN');
  assert.equal(traditional.decision, 'repair');
  assert.equal(traditional.detected, 'zh-TW');

  assert.equal(
    classifyFinalLanguage('目前 vLLM 的 request 已完成，response 可以直接交回 Claude Code。', 'zh-TW').decision,
    'compliant',
  );
});

test('V0.2.28.1 rejects structurally valid external repair that remains English and falls back to Base', async () => {
  const events = [];
  const result = await applyFinalLanguageGate({
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'The image shows two anime-style characters.' }],
  }, {
    locale: 'zh-TW',
    rewriteExternal: async () => ['The image shows two anime-style characters.'],
    rewriteBase: async () => ['這張圖片顯示兩名動漫風格角色。'],
    onEvent: async (event, fields) => events.push({ event, ...fields }),
  });

  assert.equal(result.backend, 'base');
  assert.equal(result.response.content[0].text, '這張圖片顯示兩名動漫風格角色。');
  assert.ok(events.some((entry) => entry.event === 'final_language_repair_failed'
    && entry.backend === 'external'
    && entry.code === 'language_not_compliant'
    && entry.detected === 'en'
    && entry.decision === 'repair'
    && entry.fallback === 'base'));
});

test('V0.2.28.1 rejects non-compliant Base repair and preserves the original response', async () => {
  const original = {
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'The original English answer must still be delivered if every repair backend fails.' }],
  };
  const events = [];
  const result = await applyFinalLanguageGate(original, {
    locale: 'zh-TW',
    rewriteExternal: async () => ['Still English from external processor.'],
    rewriteBase: async () => ['Still English from the Base repair.'],
    onEvent: async (event, fields) => events.push({ event, ...fields }),
  });

  assert.equal(result.action, 'fallback_original');
  assert.deepEqual(result.response, original);
  assert.ok(events.some((entry) => entry.event === 'final_language_repair_failed'
    && entry.backend === 'base'
    && entry.code === 'language_not_compliant'));
});

test('V0.2.28.12 zh-TW classifier ignores dense technical identifiers when natural-language prose is Traditional Chinese', () => {
  const text = [
    '已完成修正，以下項目現在會正確處理並保持既有行為。',
    'managed_model_round_completed final_language_processor_request CONTEXT_COMPACT_PROVIDER MODEL_RESPONSE_LANGUAGE',
    'ProgressStream classifyFinalLanguage WebFetchProcessor contextCompactEndpoint VLLM_BASE_URL LANG_PROCESSOR_MODEL',
    '如果 upstream_busy_retry 發生，Proxy 仍會維持目前連線並顯示等待狀態。',
  ].join('\n');
  const result = classifyFinalLanguage(text, 'zh-TW');
  assert.equal(result.decision, 'compliant');
  assert.equal(result.detected, 'zh');
  assert.ok(result.technicalTokenCount >= 8);
  assert.ok(result.technicalLatinChars > 100);
  assert.ok(result.naturalLatinWords < result.technicalTokenCount);
});

test('V0.2.28.13 accepts an otherwise English-classified zh-TW repair when target-language gain and source-language reduction are substantial', async () => {
  const originalText = 'The proxy completed the request but the response remains in English. The model should translate every natural language sentence for the user while preserving identifiers, commands, paths, URLs, numbers, and technical names. This paragraph intentionally contains a large amount of ordinary English prose so the source language is unambiguous and the repair operation has meaningful work to perform.';
  const shiftedRepair = '主要內容已翻成繁體中文，原本英文也明顯減少。 However some explanatory English prose still remains in the repaired answer because the translation model preserved several ordinary English sentences that describe the request status, processing behavior, response structure, and fallback behavior for the user.';
  assert.equal(classifyFinalLanguage(originalText, 'zh-TW').detected, 'en');
  assert.equal(classifyFinalLanguage(shiftedRepair, 'zh-TW').detected, 'en');

  const events = [];
  const result = await applyFinalLanguageGate({
    stop_reason: 'end_turn', content: [{ type: 'text', text: originalText }],
  }, {
    locale: 'zh-TW',
    rewriteExternal: async () => [shiftedRepair],
    rewriteBase: async () => ['Base 不應在語言轉移已明確成功時執行。'],
    onEvent: async (event, fields) => events.push({ event, ...fields }),
  });

  assert.equal(result.backend, 'external');
  assert.equal(result.action, 'rewritten');
  assert.equal(result.response.content[0].text, shiftedRepair);
  assert.ok(events.some((entry) => entry.event === 'final_language_repair_validation'
    && entry.backend === 'external'
    && entry.decision === 'accept_by_language_shift'
    && entry.original_detected === 'en'
    && entry.repaired_detected === 'en'
    && entry.target_gain >= 12
    && entry.source_reduction_ratio >= 0.30));
});

test('V0.2.28.13 rejects a repair that only adds a short target-language preface without reducing the source language', async () => {
  const originalText = 'The proxy request failed because the upstream model is busy. Please retry after the current request is completed. The response must remain complete and preserve all technical details for the user.';
  const weakRepair = `以下是繁體中文翻譯： ${originalText}`;
  const events = [];
  const result = await applyFinalLanguageGate({
    stop_reason: 'end_turn', content: [{ type: 'text', text: originalText }],
  }, {
    locale: 'zh-TW',
    rewriteExternal: async () => [weakRepair],
    rewriteBase: async () => ['代理目前忙碌，請在目前請求完成後重新嘗試；所有技術細節均已保留。'],
    onEvent: async (event, fields) => events.push({ event, ...fields }),
  });

  assert.equal(result.backend, 'base');
  assert.ok(events.some((entry) => entry.event === 'final_language_repair_validation'
    && entry.backend === 'external'
    && entry.decision === 'reject_by_language_shift'
    && entry.source_reduction <= 0));
});

test('V0.2.28.13 never rescues a wrong Chinese variant through language-shift validation', async () => {
  const originalText = 'The test result is ready. The problem has been processed and the device can now transfer data normally.';
  const simplifiedRepair = '这是测试结果，问题已经处理，设备现在可以正常进行数据传输。';
  const events = [];
  const result = await applyFinalLanguageGate({
    stop_reason: 'end_turn', content: [{ type: 'text', text: originalText }],
  }, {
    locale: 'zh-TW',
    rewriteExternal: async () => [simplifiedRepair],
    rewriteBase: async () => ['這是測試結果，問題已經處理，設備現在可以正常進行資料傳輸。'],
    onEvent: async (event, fields) => events.push({ event, ...fields }),
  });

  assert.equal(result.backend, 'base');
  assert.ok(events.some((entry) => entry.event === 'final_language_repair_validation'
    && entry.backend === 'external'
    && entry.decision === 'reject_wrong_target_language'
    && entry.repaired_detected === 'zh-CN'));
});
