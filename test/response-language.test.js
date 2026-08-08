import test from 'node:test';
import assert from 'node:assert/strict';
import * as language from '../src/i18n/response-language.js';

test('V0.2.23.1 locale registry exposes hard model and short processor instructions for all supported locales', () => {
  assert.equal(typeof language.languageProfile, 'function');
  const expected = {
    'zh-TW': ['Respond in Traditional Chinese (zh-TW).', 'Write the result in Traditional Chinese (zh-TW).'],
    'zh-CN': ['Respond in Simplified Chinese (zh-CN).', 'Write the result in Simplified Chinese (zh-CN).'],
    'en-US': ['Respond in English (en-US).', 'Write the result in English (en-US).'],
    'ja-JP': ['Respond in Japanese (ja-JP).', 'Write the result in Japanese (ja-JP).'],
    'ko-KP': ['Respond in Korean (ko-KP).', 'Write the result in Korean (ko-KP).'],
  };
  for (const [locale, [modelInstruction, processorInstruction]] of Object.entries(expected)) {
    const profile = language.languageProfile(locale);
    assert.equal(profile.modelInstruction, modelInstruction);
    assert.equal(profile.processorInstruction, processorInstruction);
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
    'zh-TW': 'Respond in Traditional Chinese (zh-TW).',
    'zh-CN': 'Respond in Simplified Chinese (zh-CN).',
    'en-US': 'Respond in English (en-US).',
    'ja-JP': 'Respond in Japanese (ja-JP).',
    'ko-KP': 'Respond in Korean (ko-KP).',
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
