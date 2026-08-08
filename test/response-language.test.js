import test from 'node:test';
import assert from 'node:assert/strict';
import * as language from '../src/i18n/response-language.js';

test('V0.2.26.4 locale registry keeps processor language instructions but removes Base-model language prompting', () => {
  assert.equal(typeof language.languageProfile, 'function');
  const expectedProcessor = {
    'zh-TW': 'Write the result in Traditional Chinese (zh-TW).',
    'zh-CN': 'Write the result in Simplified Chinese (zh-CN).',
    'en-US': 'Write the result in English (en-US).',
    'ja-JP': 'Write the result in Japanese (ja-JP).',
    'ko-KP': 'Write the result in Korean (ko-KP).',
  };
  for (const [locale, processorInstruction] of Object.entries(expectedProcessor)) {
    const profile = language.languageProfile(locale);
    assert.equal(profile.processorInstruction, processorInstruction);
    assert.equal(profile.modelInstruction, undefined);
    assert.equal(profile.modelTailInstruction, undefined);
  }
});



test('V0.2.26.4 final presentation language no longer injects a model-facing language contract', () => {
  for (const locale of language.SUPPORTED_RESPONSE_LANGUAGES) {
    const profile = language.languageProfile(locale);
    assert.equal(profile.modelInstruction, undefined);
    assert.equal(profile.modelTailInstruction, undefined);
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

import { injectResponseLanguagePolicy, injectResponseLanguageTail } from '../src/proxy/response-language-policy.js';

test('V0.2.26.4 legacy language-policy helper is a no-op and never mutates Base model input', () => {
  const original = {
    system: [{ type: 'text', text: 'Claude Code runtime instructions.' }],
    messages: [{ role: 'user', content: 'hello' }],
  };
  const before = structuredClone(original);
  for (const locale of language.SUPPORTED_RESPONSE_LANGUAGES) {
    const result = injectResponseLanguagePolicy(original, locale);
    assert.equal(result.changed, false);
    assert.deepEqual(result.request, before);
  }
  assert.deepEqual(original, before);
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

test('V0.2.26.4 locale registry no longer exposes generation-adjacent language tails', () => {
  for (const locale of language.SUPPORTED_RESPONSE_LANGUAGES) {
    assert.equal(language.languageProfile(locale).modelTailInstruction, undefined);
  }
});


test('V0.2.26.4 legacy language-tail helper is a no-op', () => {
  const original = {
    messages: [
      { role: 'user', content: '第一個問題' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: '最新問題' },
    ],
  };
  const before = structuredClone(original);
  const result = injectResponseLanguageTail(original, 'zh-TW');
  assert.equal(result.changed, false);
  assert.deepEqual(result.request, before);
  assert.deepEqual(original, before);
});

test('V0.2.26.4 tool_result history is not modified by language policy', () => {
  const original = {
    messages: [
      { role: 'user', content: '開始分析' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }] },
    ],
  };
  const result = injectResponseLanguageTail(original, 'zh-TW');
  assert.equal(result.changed, false);
  assert.deepEqual(result.request, original);
});
