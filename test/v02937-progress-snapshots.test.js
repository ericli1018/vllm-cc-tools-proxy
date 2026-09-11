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

function timelineLines(response) {
  return textDeltas(response)
    .flatMap((delta) => String(delta).split('\n'))
    .filter((line) => line.startsWith('處理中 · '));
}

test('V0.29.37 emits a complete cumulative timeline snapshot on every semantic phase transition', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  const t0 = Date.now();

  await progress.update('start', { force: true, details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: t0 } });
  await progress.update('thinking', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 2_000 } });
  await progress.update('response1', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 22_000 } });
  await progress.update('tool1', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'tool', timeline_elapsed_ms: 25_000 } });
  await progress.update('response2', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 25_000 } });
  await progress.update('tool2', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'tool', timeline_elapsed_ms: 25_000 } });
  await progress.update('response3', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 26_000 } });
  await progress.update('tool3', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'tool', timeline_elapsed_ms: 26_000 } });
  await progress.closeProgress('done', { phase: 'handoff_to_claude_code', details: { timeline_elapsed_ms: 27_000, tool_names: ['Write', 'Edit'] } });
  await progress.stop();

  const deltas = textDeltas(response);
  const visible = deltas.filter((delta) => delta !== '\n\n').join('');
  const normalized = visible.replace(/^處理中 · \d{2}:\d{2}:\d{2}/, '處理中 · HH:mm:ss');
  assert.equal(normalized, '處理中 · HH:mm:ss ○ 2s ◐ 22s ◆ 25s ◇ 25s ◆ 25s ◇ 26s ◆ 26s ◇ 27s 已產生下一步工具；交還執行…');
  assert.equal((visible.match(/處理中 · /g) || []).length, 1);
  assert.equal(visible.includes('\n'), false);
});

test('V0.29.37 heartbeat emits a full snapshot immediately and stays attached to the active phase', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  await progress.update('start', { force: true, details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: Date.now() } });
  await progress.update('thinking', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 2_000 } });
  await progress.update('hb1', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('hb2', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('response', { force: true, details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'response', timeline_elapsed_ms: 65_000 } });
  await progress.stop();

  const visible = textDeltas(response).join('');
  const normalized = visible.replace(/^處理中 · \d{2}:\d{2}:\d{2}/, '處理中 · HH:mm:ss');
  assert.equal(normalized, '處理中 · HH:mm:ss ○ 2s ◐ || 65s ◆');
  assert.equal((visible.match(/處理中 · /g) || []).length, 1);
  assert.equal(visible.includes('\n'), false);
});

test('V0.29.37 terminal handoff emits the first cumulative snapshot even when no earlier phase made progress visible', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  await progress.update('start', { force: true, details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: Date.now() } });
  await progress.closeProgress('done', { phase: 'handoff_to_claude_code', details: { timeline_elapsed_ms: 3_000, tool_names: ['Agent'] } });
  await progress.stop();
  const lines = timelineLines(response).map((line) => line.replace(/^處理中 · \d{2}:\d{2}:\d{2}/, '處理中 · HH:mm:ss'));
  assert.deepEqual(lines, ['處理中 · HH:mm:ss ○ 3s 已產生下一步 Agent；交還執行…']);
});
