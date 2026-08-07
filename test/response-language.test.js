import test from 'node:test';
import assert from 'node:assert/strict';
import * as language from '../src/i18n/response-language.js';

test('V0.2.23 locale registry exposes short model and processor instructions for all supported locales', () => {
  assert.equal(typeof language.languageProfile, 'function');
  const expected = {
    'zh-TW': ['Default to Traditional Chinese (zh-TW) for user-visible responses. Preserve technical literals verbatim.', 'Write the result in Traditional Chinese (zh-TW).'],
    'zh-CN': ['Default to Simplified Chinese (zh-CN) for user-visible responses. Preserve technical literals verbatim.', 'Write the result in Simplified Chinese (zh-CN).'],
    'en-US': ['Default to English (en-US) for user-visible responses. Preserve technical literals verbatim.', 'Write the result in English (en-US).'],
    'ja-JP': ['Default to Japanese (ja-JP) for user-visible responses. Preserve technical literals verbatim.', 'Write the result in Japanese (ja-JP).'],
    'ko-KP': ['Default to Korean (ko-KP) for user-visible responses. Preserve technical literals verbatim.', 'Write the result in Korean (ko-KP).'],
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
  assert.equal(language.statusText('en-US', 'queueWait', { position: 3 }), 'Task queued; 3 task(s) ahead…');
  assert.equal(language.statusText('ja-JP', 'handoffSingle', { tool: 'WebFetch' }), 'メインモデルが次の操作として WebFetch を生成しました。Claude Code に制御を戻しています…');
  assert.equal(language.statusText('ko-KP', 'modelWaiting', { seconds: 30 }), '주 모델이 이 요청을 처리하고 있습니다. 30초 경과…');
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
