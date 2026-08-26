import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  SUPPORTED_RESPONSE_LANGUAGES,
  progressBlockHeader,
  statusText,
} from '../src/i18n/response-language.js';
import {
  ProgressStream,
  hasProgressHistory,
  stripProgressHistory,
} from '../src/proxy/progress.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
  }
  writeHead() {}
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
}

const expectedHeaders = Object.freeze({
  'zh-TW': '模型處理中 · 09:43:02',
  'zh-CN': '模型处理中 · 09:43:02',
  'en-US': 'Model processing · 09:43:02',
  'ja-JP': 'モデル処理中 · 09:43:02',
  'ko-KP': '모델 처리 중 · 09:43:02',
});

const forbiddenMainMarkers = Object.freeze({
  'zh-TW': /主模型/,
  'zh-CN': /主模型/,
  'en-US': /\bmain[- ]model\b/i,
  'ja-JP': /メインモデル/,
  'ko-KP': /주 모델/,
});

const modelProgressCases = Object.freeze([
  ['modelWaiting', { seconds: 30, receivedBytes: 1250 }],
  ['modelFirstByte', { seconds: 2, receivedBytes: 6 }],
  ['queueWait', { seconds: 3, position: 1 }],
  ['upstreamBusyWait', { seconds: 5 }],
  ['upstreamBusyRetry', { seconds: 5, attempt: 2 }],
  ['upstreamBusyAccepted', {}],
  ['modelPlanning', {}],
  ['modelToolResults', {}],
  ['modelStallRecovery', { attempt: 1, total: 2 }],
  ['finalChannelRecovery', {}],
  ['emptyEndTurnRegeneration', {}],
  ['continuationRecovery', { candidateChars: 120 }],
  ['finalRoundReserved', {}],
  ['mediaReady', {}],
  ['baseRequestStart', {}],
  ['baseHeadersReceived', {}],
  ['handoffSingle', { tool: 'Bash' }],
  ['handoffMultiple', {}],
  ['finalVisible', {}],
  ['finalOutput', {}],
  ['streamingTool', {}],
  ['streamingVisible', {}],
  ['streamingThinking', {}],
  ['streamingOutput', {}],
  ['modelHeartbeat', { seconds: 2, receivedBytes: 6, modelPhase: 'thinking', recentBytesPerSecond: 3 }],
  ['modelPhaseChanged', { modelPhase: 'response', receivedBytes: 596 }],
]);

test('V0.29.33 localizes the neutral model-processing header with HH:mm:ss in every supported locale', () => {
  for (const locale of SUPPORTED_RESPONSE_LANGUAGES) {
    assert.equal(progressBlockHeader(locale, { timeText: '09:43:02' }), expectedHeaders[locale]);
  }
  assert.equal(progressBlockHeader('bad-locale', { timeText: '09:43:02' }), expectedHeaders['en-US']);
});

test('V0.29.33 removes Main-model wording from visible model progress across all supported locales', () => {
  for (const locale of SUPPORTED_RESPONSE_LANGUAGES) {
    for (const [key, values] of modelProgressCases) {
      const rendered = statusText(locale, key, values);
      assert.doesNotMatch(rendered, forbiddenMainMarkers[locale], `${locale}/${key}: ${rendered}`);
    }
  }
});

test('V0.29.33 ProgressStream emits one timestamped neutral header and keeps it stable for the progress block', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    locale: 'zh-TW',
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
  });
  await progress.open();
  await progress.update('◐ 模型開始思考 · 0 B', { force: true, details: { phase: 'model_stream_phase' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await progress.update('◆ 模型開始回應 · 596 B', { force: true, details: { phase: 'model_stream_phase' } });
  await progress.closeProgress('模型已產生下一步工具；正在交還 Claude Code 執行…');
  await progress.stop();

  const wire = response.chunks.join('');
  const matches = [...wire.matchAll(/模型處理中 · (\d{2}:\d{2}:\d{2})/g)];
  assert.equal(matches.length, 1, wire);
  assert.doesNotMatch(wire, /目前處理進度：/);
  assert.doesNotMatch(wire, /主模型/);
});

test('V0.29.33 progress-history stripping recognizes new timestamped headers and all legacy locale headers', () => {
  const headers = [
    '模型處理中 · 09:43:02',
    '模型处理中 · 09:43:02',
    'Model processing · 09:43:02',
    'モデル処理中 · 09:43:02',
    '모델 처리 중 · 09:43:02',
    '目前處理進度：',
    '当前处理进度：',
    'Current progress:',
    '現在の処理状況：',
    '현재 처리 상태:',
  ];
  for (const header of headers) {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: `${header}\n◐ model progress` }] }];
    assert.equal(hasProgressHistory(messages), true, header);
    assert.deepEqual(stripProgressHistory(messages)[0].content, [], header);
  }
});
