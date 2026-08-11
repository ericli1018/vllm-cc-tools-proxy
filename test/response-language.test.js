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

test('V0.2.28.14 progress headers remain stable labels even when live bytes are available', () => {
  const expectedHeaders = {
    'zh-TW': '目前處理進度：',
    'zh-CN': '当前处理进度：',
    'en-US': 'Current progress:',
    'ja-JP': '現在の処理状況：',
    'ko-KP': '현재 처리 상태:',
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


test('V0.2.28.14 keeps external-to-Base language repair fallback distinct with processor telemetry glyph', () => {
  assert.equal(
    language.statusText('zh-TW', 'finalLanguageRepairFallbackBase'),
    '◇ 外部語言處理未達要求；正在改由主模型完成繁體中文轉換…',
  );
});

test('V0.2.28.5 controlled continuation progress reports produced and preserved model-state sizes', () => {
  assert.equal(
    language.statusText('zh-TW', 'continuationRecovery', { candidateChars: 184221 }),
    '主模型尚未形成有效下一步；本輪產生 184,221 字元工作狀態，正在整理並保留續接重點…',
  );
  assert.equal(
    language.statusText('zh-TW', 'continuationStatePreserved', { candidateChars: 184221, handoffChars: 28411, compressed: true }),
    '已將本輪 184,221 字元工作狀態整理為 28,411 字元續接狀態；正在基於剛才的工作內容接續完成下一步…',
  );
  assert.equal(
    language.statusText('en-US', 'continuationStatePreserved', { candidateChars: 5000, handoffChars: 5000, compressed: false }),
    'Preserved 5,000 characters of this round’s model working state; continuing from that work…',
  );
});

test('V0.2.28.14 renders compact main-model telemetry with localized phase, rate and stall state', () => {
  const cases = {
    'zh-TW': {
      waiting: '◌ 主模型等待輸出 · 29s · 0 B',
      thinking: '◐ 主模型思考中 · 60s · 29.82 KB · 512 B/s',
      response: '◆ 主模型回應中 · 90s · 43.59 KB · 1.25 KB/s',
      tool: '◇ 主模型建立工具動作 · 120s · 57.63 KB · 256 B/s',
      stalled: '⚠ 主模型資料暫停 · 30s 無新資料 · 總計 57.63 KB',
    },
    'zh-CN': {
      waiting: '◌ 主模型等待输出 · 29s · 0 B',
      thinking: '◐ 主模型思考中 · 60s · 29.82 KB · 512 B/s',
      response: '◆ 主模型响应中 · 90s · 43.59 KB · 1.25 KB/s',
      tool: '◇ 主模型建立工具动作 · 120s · 57.63 KB · 256 B/s',
      stalled: '⚠ 主模型数据暂停 · 30s 无新数据 · 总计 57.63 KB',
    },
    'en-US': {
      waiting: '◌ Main model waiting · 29s · 0 B',
      thinking: '◐ Main model thinking · 60s · 29.82 KB · 512 B/s',
      response: '◆ Main model responding · 90s · 43.59 KB · 1.25 KB/s',
      tool: '◇ Main model building tool action · 120s · 57.63 KB · 256 B/s',
      stalled: '⚠ Main model stalled · no upstream data for 30s · total 57.63 KB',
    },
    'ja-JP': {
      waiting: '◌ メインモデル待機中 · 29s · 0 B',
      thinking: '◐ メインモデル思考中 · 60s · 29.82 KB · 512 B/s',
      response: '◆ メインモデル応答中 · 90s · 43.59 KB · 1.25 KB/s',
      tool: '◇ メインモデルがツール操作を生成中 · 120s · 57.63 KB · 256 B/s',
      stalled: '⚠ メインモデルのデータ受信が停止 · 30s 新規データなし · 合計 57.63 KB',
    },
    'ko-KP': {
      waiting: '◌ 주 모델 출력 대기 · 29s · 0 B',
      thinking: '◐ 주 모델 사고 중 · 60s · 29.82 KB · 512 B/s',
      response: '◆ 주 모델 응답 중 · 90s · 43.59 KB · 1.25 KB/s',
      tool: '◇ 주 모델 도구 동작 생성 중 · 120s · 57.63 KB · 256 B/s',
      stalled: '⚠ 주 모델 데이터 정체 · 30s 동안 새 데이터 없음 · 총 57.63 KB',
    },
  };
  for (const [locale, expected] of Object.entries(cases)) {
    assert.equal(language.statusText(locale, 'modelHeartbeat', {
      seconds: 29, receivedBytes: 0, modelPhase: 'waiting', pulseIndex: 0,
    }), expected.waiting);
    assert.equal(language.statusText(locale, 'modelHeartbeat', {
      seconds: 60, receivedBytes: 30536, modelPhase: 'thinking', recentBytesPerSecond: 512, pulseIndex: 0,
    }), expected.thinking);
    assert.equal(language.statusText(locale, 'modelHeartbeat', {
      seconds: 90, receivedBytes: 44636, modelPhase: 'response', recentBytesPerSecond: 1280, pulseIndex: 1,
    }), expected.response);
    assert.equal(language.statusText(locale, 'modelHeartbeat', {
      seconds: 120, receivedBytes: 59013, modelPhase: 'tool', recentBytesPerSecond: 256, pulseIndex: 2,
    }), expected.tool);
    assert.equal(language.statusText(locale, 'modelHeartbeat', {
      seconds: 150, receivedBytes: 59013, modelPhase: 'response', stalled: true, idleSeconds: 30, pulseIndex: 3,
    }), expected.stalled);
  }
});

test('V0.2.28.14 thinking pulse rotates only the glyph and phase telemetry stays single-line', () => {
  const frames = [0, 1, 2, 3].map((pulseIndex) => language.statusText('zh-TW', 'modelHeartbeat', {
    seconds: 60, receivedBytes: 4096, modelPhase: 'thinking', recentBytesPerSecond: 100, pulseIndex,
  }));
  assert.deepEqual(frames.map((line) => [...line][0]), ['◐', '◓', '◑', '◒']);
  for (const line of frames) assert.doesNotMatch(line, /\r|\n/);
});

test('V0.2.28.14 renders compact localized model phase transition notices', () => {
  assert.equal(language.statusText('zh-TW', 'modelPhaseChanged', { modelPhase: 'thinking', receivedBytes: 494 }), '◐ 主模型開始思考 · 494 B');
  assert.equal(language.statusText('zh-TW', 'modelPhaseChanged', { modelPhase: 'response', receivedBytes: 2048 }), '◆ 主模型開始回應 · 2 KB');
  assert.equal(language.statusText('zh-TW', 'modelPhaseChanged', { modelPhase: 'tool', receivedBytes: 4096 }), '◇ 主模型建立工具動作 · 4 KB');
  assert.equal(language.statusText('en-US', 'modelPhaseChanged', { modelPhase: 'response', receivedBytes: 2048 }), '◆ Main model started responding · 2 KB');
});

test('V0.2.28.14 prefixes busy, language and vision processor states in every locale', () => {
  for (const locale of language.SUPPORTED_RESPONSE_LANGUAGES) {
    assert.match(language.statusText(locale, 'upstreamBusyRetry', { seconds: 30, attempt: 3 }), /^↻ /);
    assert.match(language.statusText(locale, 'finalLanguageRepair'), /^◇ /);
    assert.match(language.statusText(locale, 'imageVision'), /^◇ /);
  }
});

test('V0.2.28.16 native status line localizes runtime phases for every supported locale', () => {
  const samples = {
    'zh-TW': /思考中/,
    'zh-CN': /思考中/,
    'en-US': /THINKING/,
    'ja-JP': /思考中/,
    'ko-KP': /사고 중/,
  };
  for (const [locale, expected] of Object.entries(samples)) {
    const line = language.formatRuntimeStatusLine(locale, {
      version: '0.2.28.16', phase: 'thinking', elapsedMs: 59000,
      receivedBytes: 45906, throughputBps: 760, pulseIndex: 1,
    });
    assert.match(line, /CC TOOL PROXY 0\.2\.28\.16/);
    assert.match(line, expected);
    assert.match(line, /59s/);
    assert.match(line, /44\.83 KB/);
    assert.match(line, /760 B\/s/);
    assert.match(line, /◓/);
  }
});
