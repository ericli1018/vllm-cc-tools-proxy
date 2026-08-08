import test from 'node:test';
import assert from 'node:assert/strict';
import * as language from '../src/i18n/response-language.js';

test('V0.2.23.1 locale registry exposes hard model and short processor instructions for all supported locales', () => {
  assert.equal(typeof language.languageProfile, 'function');
  const expected = {
    'zh-TW': ['在 think 思考區塊之外，所有使用者可見的自然語言內容都必須使用繁體中文（zh-TW）。\n除非使用者明確要求，否則不得切換為其他語言。', 'Write the result in Traditional Chinese (zh-TW).'],
    'zh-CN': ['在 think 思考区块之外，所有用户可见的自然语言内容都必须使用简体中文（zh-CN）。\n除非用户明确要求，否则不得切换为其他语言。', 'Write the result in Simplified Chinese (zh-CN).'],
    'en-US': ['Outside the think reasoning block, all user-visible natural-language content MUST be written in English (en-US).\nDo not switch to another language unless the user explicitly requests it.', 'Write the result in English (en-US).'],
    'ja-JP': ['think 推論ブロックの外では、ユーザーに表示されるすべての自然言語の内容を日本語（ja-JP）で記述しなければなりません。\nユーザーが明示的に要求しない限り、他の言語に切り替えないでください。', 'Write the result in Japanese (ja-JP).'],
    'ko-KP': ['think 추론 블록 밖에서는 사용자에게 표시되는 모든 자연어 내용을 한국어(ko-KP)로 작성해야 합니다.\n사용자가 명시적으로 요청하지 않는 한 다른 언어로 전환하지 마십시오.', 'Write the result in Korean (ko-KP).'],
  };
  for (const [locale, [modelInstruction, processorInstruction]] of Object.entries(expected)) {
    const profile = language.languageProfile(locale);
    assert.equal(profile.modelInstruction, modelInstruction);
    assert.equal(profile.processorInstruction, processorInstruction);
  }
});



test('V0.2.26.2 model language contract uses the target language and constrains only user-visible prose', () => {
  const expected = {
    'zh-TW': '在 think 思考區塊之外，所有使用者可見的自然語言內容都必須使用繁體中文（zh-TW）。\n除非使用者明確要求，否則不得切換為其他語言。',
    'zh-CN': '在 think 思考区块之外，所有用户可见的自然语言内容都必须使用简体中文（zh-CN）。\n除非用户明确要求，否则不得切换为其他语言。',
    'en-US': 'Outside the think reasoning block, all user-visible natural-language content MUST be written in English (en-US).\nDo not switch to another language unless the user explicitly requests it.',
    'ja-JP': 'think 推論ブロックの外では、ユーザーに表示されるすべての自然言語の内容を日本語（ja-JP）で記述しなければなりません。\nユーザーが明示的に要求しない限り、他の言語に切り替えないでください。',
    'ko-KP': 'think 추론 블록 밖에서는 사용자에게 표시되는 모든 자연어 내용을 한국어(ko-KP)로 작성해야 합니다.\n사용자가 명시적으로 요청하지 않는 한 다른 언어로 전환하지 마십시오.',
  };

  for (const [locale, instruction] of Object.entries(expected)) {
    assert.equal(language.languageProfile(locale).modelInstruction, instruction);
    assert.doesNotMatch(instruction, /\btool\b|protocol|JSON/i);
    assert.doesNotMatch(instruction, /<\/?think>/i);
  }
});

test('V0.2.23 locale registry localizes core progress/status vocabulary and preserves literals', () => {
  assert.equal(typeof language.statusText, 'function');
  assert.equal(language.statusText('zh-TW', 'searchStart', { query: 'libuv TLS' }), '正在搜尋：libuv TLS…');
  assert.equal(language.statusText('zh-CN', 'fetchDone', { host: 'example.com' }), 'example.com 内容已就绪。');
  assert.equal(language.statusText('en-US', 'queueWait', { position: 3 }), 'Waiting for main-model capacity; queued for 0s with 3 task(s) ahead…');
  assert.equal(language.statusText('ja-JP', 'handoffSingle', { tool: 'WebFetch' }), 'メインモデルが次の操作として WebFetch を生成しました。Claude Code に制御を戻しています…');
  assert.equal(language.statusText('ko-KP', 'modelWaiting', { seconds: 30 }), '주 모델이 이 요청을 처리하고 있습니다. 30초 실행…');
});

test('V0.2.23 progress headers are locale-specific with English fallback', () => {
  assert.equal(typeof language.progressBlockHeader, 'function');
  assert.equal(language.progressBlockHeader('zh-TW'), '目前處理進度：');
  assert.equal(language.progressBlockHeader('zh-CN'), '当前处理进度：');
  assert.equal(language.progressBlockHeader('en-US'), 'Current progress:');
  assert.equal(language.progressBlockHeader('ja-JP'), '現在の処理状況：');
  assert.equal(language.progressBlockHeader('ko-KP'), '현재 처리 상태:');
  assert.equal(language.progressBlockHeader('bad-locale'), 'Current progress:');
});

import { injectResponseLanguagePolicy } from '../src/proxy/response-language-policy.js';

test('V0.2.23.1 language policy survives vLLM direct system-block join with a hard boundary', () => {
  const expected = {
    'zh-TW': '在 think 思考區塊之外，所有使用者可見的自然語言內容都必須使用繁體中文（zh-TW）。\n除非使用者明確要求，否則不得切換為其他語言。',
    'zh-CN': '在 think 思考区块之外，所有用户可见的自然语言内容都必须使用简体中文（zh-CN）。\n除非用户明确要求，否则不得切换为其他语言。',
    'en-US': 'Outside the think reasoning block, all user-visible natural-language content MUST be written in English (en-US).\nDo not switch to another language unless the user explicitly requests it.',
    'ja-JP': 'think 推論ブロックの外では、ユーザーに表示されるすべての自然言語の内容を日本語（ja-JP）で記述しなければなりません。\nユーザーが明示的に要求しない限り、他の言語に切り替えないでください。',
    'ko-KP': 'think 추론 블록 밖에서는 사용자에게 표시되는 모든 자연어 내용을 한국어(ko-KP)로 작성해야 합니다.\n사용자가 명시적으로 요청하지 않는 한 다른 언어로 전환하지 마십시오.',
  };

  for (const [locale, instruction] of Object.entries(expected)) {
    const original = {
      system: [
        { type: 'text', text: 'Claude Code runtime instructions end here.' },
        { type: 'text', text: 'Project policy ends here.' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    };
    const injected = injectResponseLanguagePolicy(original, locale).request;
    const renderedLikeVllm = injected.system
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('');

    assert.equal(renderedLikeVllm.endsWith(`Project policy ends here.\n\n${instruction}`), true);
    assert.equal(renderedLikeVllm.includes('Default to '), false);
  }
});

test('V0.2.24 formats cumulative Base vLLM response bytes with binary units', () => {
  assert.equal(typeof language.formatReceivedBytes, 'function');
  assert.equal(language.formatReceivedBytes(20), '20 B');
  assert.equal(language.formatReceivedBytes(1250), '1.22 KB');
  assert.equal(language.formatReceivedBytes(1174405), '1.12 MB');
  assert.equal(language.formatReceivedBytes(3 * 1024 ** 3), '3 GB');
  assert.equal(language.formatReceivedBytes(-1), '0 B');
});

test('V0.2.24 progress headers and heartbeats include cumulative received bytes in every locale', () => {
  const expectedHeaders = {
    'zh-TW': '目前處理進度（已收到 1.22 KB）：',
    'zh-CN': '当前处理进度（已收到 1.22 KB）：',
    'en-US': 'Current progress (received 1.22 KB):',
    'ja-JP': '現在の処理状況（受信 1.22 KB）：',
    'ko-KP': '현재 처리 상태 (수신 1.22 KB):',
  };
  const expectedWaiting = {
    'zh-TW': '主模型仍在處理本輪請求，已執行 30 秒（已收到 1.22 KB）…',
    'zh-CN': '主模型仍在处理本轮请求，已执行 30 秒（已收到 1.22 KB）…',
    'en-US': 'The main model is still processing this request. Running for 30s (received 1.22 KB)…',
    'ja-JP': 'メインモデルがこのリクエストを処理中です。実行 30 秒（受信 1.22 KB）…',
    'ko-KP': '주 모델이 이 요청을 처리하고 있습니다. 30초 실행 (수신 1.22 KB)…',
  };
  for (const locale of Object.keys(expectedHeaders)) {
    assert.equal(language.progressBlockHeader(locale, { receivedBytes: 1250 }), expectedHeaders[locale]);
    assert.equal(language.statusText(locale, 'modelWaiting', { seconds: 30, receivedBytes: 1250 }), expectedWaiting[locale]);
  }
});

test('V0.2.25 queue and model heartbeat vocabulary distinguish queue time from model run time', () => {
  assert.equal(language.statusText('zh-TW', 'queueWait', { position: 2, seconds: 60 }), '正在等待主模型執行資源，已排隊 60 秒，目前前方有 2 個任務…');
  assert.equal(language.statusText('zh-TW', 'modelWaiting', { seconds: 30, receivedBytes: 1250 }), '主模型仍在處理本輪請求，已執行 30 秒（已收到 1.22 KB）…');
  assert.equal(language.statusText('en-US', 'queueWait', { position: 1, seconds: 90 }), 'Waiting for main-model capacity; queued for 90s with 1 task(s) ahead…');
  assert.equal(language.statusText('en-US', 'modelWaiting', { seconds: 30 }), 'The main model is still processing this request. Running for 30s…');
});

test('V0.2.25.2 localizes immediate first-byte model progress in every locale', () => {
  const expected = {
    'zh-TW': '主模型已開始回傳資料，已執行 45 秒（已收到 284 B）…',
    'zh-CN': '主模型已开始返回数据，已执行 45 秒（已收到 284 B）…',
    'en-US': 'The main model has started returning data. Running for 45s (received 284 B)…',
    'ja-JP': 'メインモデルがデータを返し始めました。実行 45 秒（受信 284 B）…',
    'ko-KP': '주 모델이 데이터를 반환하기 시작했습니다. 45초 실행 (수신 284 B)…',
  };
  for (const [locale, text] of Object.entries(expected)) {
    assert.equal(language.statusText(locale, 'modelFirstByte', { seconds: 45, receivedBytes: 284 }), text);
  }
});

test('V0.2.26.3 locale registry exposes a compact generation-adjacent tail in the target language', () => {
  const expected = {
    'zh-TW': '若使用者未明確要求其他語言，請以繁體中文（zh-TW）撰寫給使用者看的回答。',
    'zh-CN': '若用户未明确要求其他语言，请使用简体中文（zh-CN）撰写给用户看的回答。',
    'en-US': 'Unless the user explicitly requests another language, write the user-visible answer in English (en-US).',
    'ja-JP': 'ユーザーが他の言語を明示的に要求していない限り、ユーザー向けの回答は日本語（ja-JP）で記述してください。',
    'ko-KP': '사용자가 다른 언어를 명시적으로 요청하지 않는 한, 사용자에게 보여 줄 답변은 한국어(ko-KP)로 작성하십시오.',
  };

  for (const [locale, tailInstruction] of Object.entries(expected)) {
    const profile = language.languageProfile(locale);
    assert.equal(profile.modelTailInstruction, tailInstruction);
    assert.doesNotMatch(tailInstruction, /<\/?think>|\btool\b|protocol|JSON/i);
  }
});

import { injectResponseLanguageTail } from '../src/proxy/response-language-policy.js';

test('V0.2.26.3 language tail is appended to the latest user turn without mutating the source request', () => {
  const original = {
    messages: [
      { role: 'user', content: '第一個問題' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: '最新問題' },
    ],
  };
  const before = structuredClone(original);
  const result = injectResponseLanguageTail(original, 'zh-TW');

  assert.deepEqual(original, before);
  assert.equal(result.changed, true);
  assert.equal(result.request.messages[0].content, '第一個問題');
  assert.equal(
    result.request.messages[2].content,
    '最新問題\n\n若使用者未明確要求其他語言，請以繁體中文（zh-TW）撰寫給使用者看的回答。',
  );
});

test('V0.2.26.3 language tail can follow a tool_result user turn and is re-anchored instead of duplicated', () => {
  const tail = '若使用者未明確要求其他語言，請以繁體中文（zh-TW）撰寫給使用者看的回答。';
  const original = {
    messages: [
      { role: 'user', content: `開始分析\n\n${tail}` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }] },
    ],
  };

  const result = injectResponseLanguageTail(original, 'zh-TW');
  assert.equal(result.changed, true);
  assert.equal(result.request.messages[0].content, '開始分析');
  assert.deepEqual(result.request.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' },
    { type: 'text', text: tail },
  ]);
  const serialized = JSON.stringify(result.request.messages);
  assert.equal(serialized.split(tail).length - 1, 1);
});
