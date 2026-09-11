import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressStream, hasProgressHistory, stripProgressHistory } from '../src/proxy/progress.js';
import { formatRuntimeStatusLine, modelTimelineHeader } from '../src/i18n/response-language.js';

class FakeResponse {
  constructor() { this.chunks = []; this.writableLength = 0; }
  writeHead() {}
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  once() {}
}

function textDeltas(response) {
  return response.chunks.join('').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((data) => data?.type === 'content_block_delta')
    .map((data) => data.delta?.text ?? data.delta?.thinking ?? '');
}

test('V0.29.36 model progress is one append-only timeline with real heartbeat bars', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    locale: 'zh-TW',
  });
  await progress.open();
  const t0 = Date.now();
  await progress.update('legacy planning copy is not rendered', {
    force: true,
    details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: t0 },
  });
  await progress.update('legacy heartbeat copy is not rendered', {
    force: true,
    kind: 'semantic_heartbeat',
    details: { phase: 'semantic_heartbeat' },
  });
  await progress.update('legacy thinking copy is not rendered', {
    force: true,
    details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 62_000 },
  });
  await progress.update('legacy heartbeat copy 2 is not rendered', {
    force: true,
    kind: 'semantic_heartbeat',
    details: { phase: 'semantic_heartbeat' },
  });
  await progress.update('legacy response copy is not rendered', {
    force: true,
    details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 65_000 },
  });
  await progress.update('legacy tool copy is not rendered', {
    force: true,
    details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'tool', timeline_elapsed_ms: 67_000 },
  });
  await progress.closeProgress('已產生下一步工具；交還執行…', {
    phase: 'handoff_to_claude_code',
    details: { timeline_elapsed_ms: 70_000, tool_names: ['Write'] },
  });
  await progress.stop();

  const deltas = textDeltas(response);
  assert.match(deltas[0], /^處理中 · \d{2}:\d{2}:\d{2} ○$/);
  assert.equal(deltas[1], ' |');
  assert.equal(deltas[2], ' 62s ◐');
  assert.equal(deltas[3], ' |');
  assert.equal(deltas[4], ' 65s ◆');
  assert.equal(deltas[5], ' 67s ◇');
  assert.equal(deltas[6], ' 70s 已產生下一步 Write；交還執行…');
  assert.doesNotMatch(deltas.slice(0, 7).join(''), /\n|\r|模型開始思考|模型思考中|模型開始回應|模型建立工具動作/);
});

test('V0.29.36 progress timeline keeps waiting, thinking, response and tool heartbeat bars independent', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  await progress.update('start', { force: true, details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: Date.now() } });
  await progress.update('hb1', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('hb2', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('thinking', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 62_000 } });
  await progress.update('hb3', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('response', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 95_000 } });
  await progress.update('hb4', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('tool', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'tool', timeline_elapsed_ms: 130_000 } });
  await progress.update('hb5', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.stop();
  assert.match(textDeltas(response).join(''), /^處理中 · \d{2}:\d{2}:\d{2} ○ \|\| 62s ◐ \| 95s ◆ \| 130s ◇ \|$/);
});

test('V0.29.36 localized progress headers use compact Processing wording and remain strippable', () => {
  assert.match(modelTimelineHeader('zh-TW', { timeText: '15:52:07' }), /^處理中 · 15:52:07$/);
  assert.match(modelTimelineHeader('zh-CN', { timeText: '15:52:07' }), /^处理中 · 15:52:07$/);
  assert.match(modelTimelineHeader('en-US', { timeText: '15:52:07' }), /^Processing · 15:52:07$/);
  assert.match(modelTimelineHeader('ja-JP', { timeText: '15:52:07' }), /^処理中 · 15:52:07$/);
  assert.match(modelTimelineHeader('ko-KP', { timeText: '15:52:07' }), /^처리 중 · 15:52:07$/);
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: '處理中 · 15:52:07 ○ || 62s ◐ | 95s ◆ 130s ◇ 140s 已產生下一步工具；交還執行…' }] }];
  assert.equal(hasProgressHistory(messages), true);
  assert.deepEqual(stripProgressHistory(messages)[0].content, []);
});

test('V0.29.36 runtime statusLine brand is compact CCTP', () => {
  const line = formatRuntimeStatusLine('zh-TW', { version: '0.29.36', phase: 'thinking', elapsedMs: 45_000 });
  assert.match(line, /^◆ CCTP 0\.29\.36 │/);
  assert.doesNotMatch(line, /CC TOOL PROXY/);
});

test('V0.29.36 model timeline opens as one new row after an existing banner/progress block, then stays inline', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  await progress.showStartupBanner('BANNER');
  await progress.update('start', {
    force: true,
    details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: Date.now(), round: 1 },
  });
  await progress.update('thinking', {
    force: true,
    details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 3_000 },
  });
  await progress.update('hb', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.stop();
  const deltas = textDeltas(response);
  assert.equal(deltas[0], 'BANNER');
  assert.match(deltas[1], /^\n處理中 · \d{2}:\d{2}:\d{2} ○$/);
  assert.equal(deltas[2], ' 3s ◐');
  assert.equal(deltas[3], ' |');
});

test('V0.29.36 stalled semantic heartbeat stays single-line but preserves a visible warning marker', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  await progress.update('start', { force: true, details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: Date.now() } });
  await progress.update('⚠ 模型資料暫停 · 30s 無新資料', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.stop();
  assert.match(textDeltas(response).join(''), /^處理中 · \d{2}:\d{2}:\d{2} ○ \| ⚠$/);
});
