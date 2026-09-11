import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressStream } from '../src/proxy/progress.js';

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

function normalizeHeader(text) {
  return String(text).replace(/^處理中 · \d{2}:\d{2}:\d{2}/, '處理中 · HH:mm:ss');
}

test('V0.29.38 keeps one physical progress line and appends only phase deltas', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  const t0 = Date.now();

  await progress.update('start', { force: true, details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: t0 } });
  await progress.update('thinking', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 1_000 } });
  await progress.update('response1', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 4_000 } });
  await progress.update('tool1', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'tool', timeline_elapsed_ms: 5_000 } });
  await progress.update('response2', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 5_000 } });
  await progress.update('tool2', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'tool', timeline_elapsed_ms: 6_000 } });
  await progress.closeProgress('done', { phase: 'handoff_to_claude_code', details: { timeline_elapsed_ms: 7_000, tool_names: ['Write', 'Edit'] } });
  await progress.stop();

  const deltas = textDeltas(response);
  assert.equal(normalizeHeader(deltas[0]), '處理中 · HH:mm:ss ○ 1s ◐');
  assert.deepEqual(deltas.slice(1, 6), [
    ' 4s ◆',
    ' 5s ◇',
    ' 5s ◆',
    ' 6s ◇',
    ' 7s 已產生下一步工具；交還執行…',
  ]);
  assert.equal(deltas[6], '\n\n');

  const visible = deltas.slice(0, 6).join('');
  assert.equal((visible.match(/處理中 · /g) || []).length, 1, 'header must be emitted once');
  assert.equal(visible.includes('\n'), false, 'timeline updates must stay on the same physical line');
  assert.equal(normalizeHeader(visible), '處理中 · HH:mm:ss ○ 1s ◐ 4s ◆ 5s ◇ 5s ◆ 6s ◇ 7s 已產生下一步工具；交還執行…');
});

test('V0.29.38 heartbeat appends bars to the same line and never replays the header', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();

  await progress.update('start', { force: true, details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: Date.now() } });
  await progress.update('thinking', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 2_000 } });
  await progress.update('hb1', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('hb2', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('response', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 65_000 } });
  await progress.stop();

  const deltas = textDeltas(response);
  assert.equal(normalizeHeader(deltas[0]), '處理中 · HH:mm:ss ○ 2s ◐');
  assert.deepEqual(deltas.slice(1), [' |', '|', ' 65s ◆']);
  const visible = deltas.join('');
  assert.equal((visible.match(/處理中 · /g) || []).length, 1);
  assert.equal(visible.includes('\n'), false);
  assert.equal(normalizeHeader(visible), '處理中 · HH:mm:ss ○ 2s ◐ || 65s ◆');
});
