import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressStream, stripProgressHistory } from '../src/proxy/progress.js';
import { createMediaProgressTracker } from '../src/proxy/media-progress.js';

class FakeResponse {
  constructor() { this.chunks = []; this.writableLength = 0; }
  writeHead() {}
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  once() {}
}
const events = res => res.chunks.join('').split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const deltas = res => events(res).filter(e => e.type === 'content_block_delta').map(e => e.delta.text ?? e.delta.thinking ?? '');
const body = (type = 'document', name = 'board.pdf') => [{ role: 'user', content: [{ type, source: { type: 'base64', media_type: type === 'document' ? 'application/pdf' : 'image/png', data: 'x', filename: name } }] }];
const mediaPath = ['messages', 0, 'content', 0];
function stream(t, options = {}) {
  const res = new FakeResponse();
  const progress = new ProgressStream(res, { visibleAfterMs: 0, pingIntervalMs: 60_000, ...options });
  t.after(() => progress.dispose());
  return { res, progress };
}

test('V0.29.68 media details preserve safe source context without adding progress to model events', () => {
  const tracker = createMediaProgressTracker(body('image', '/private/line\n\u2028image.png'));
  const detail = tracker.timelineDetails({ phase: 'image_vision', path: mediaPath });
  assert.equal(detail.media_timeline, true);
  assert.match(detail.media_context, /image\.png/);
  assert.match(detail.media_context, /圖片 1\/1/);
  assert.doesNotMatch(detail.media_context + detail.media_label, /private|[\r\n\u2028\u2029]/);
  assert.equal(detail.media_label, '視覺判讀');
  assert.deepEqual(tracker.timelineDetails({ phase: 'managed_model_round_start', round: 1 }), { phase: 'managed_model_round_start', round: 1 });
});

test('V0.29.68 media counters distinguish PDF pages from zoom tiles, and never infer a percentage', () => {
  const tracker = createMediaProgressTracker(body());
  const page = tracker.timelineDetails({ phase: 'pdf_classify', path: mediaPath, completed: 2, total: 10 });
  assert.match(page.media_label, /分類.*頁 2\/10/);
  const tile = tracker.timelineDetails({ phase: 'pdf_zoom_tile_analyze', path: mediaPath, page: 7, tile: 2, completed: 2, total: 6 });
  assert.match(tile.media_label, /頁 7/);
  assert.match(tile.media_label, /區塊 2\/6/);
  assert.doesNotMatch(tile.media_label, /頁 2\/6|%/);
  const failed = tracker.timelineDetails({ phase: 'pdf_zoom_tile_failed', path: mediaPath, page: 7, completed: 2, total: 6 });
  assert.equal(failed.media_warning, true);
  assert.match(failed.media_label, /失敗/);
});

test('V0.29.68 Read(PDF) images retain explicit page scope without guessing unspecified page numbers', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/work/paper.pdf', pages: '4,6' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: [body('image')[0].content[0], body('image')[0].content[0]] }] },
  ];
  // Read provenance supplies the filename, not the fixture's source filename.
  for (const image of messages[1].content[0].content) delete image.source.filename;
  const tracker = createMediaProgressTracker(messages);
  const details = tracker.timelineDetails({ phase: 'image_vision', path: ['messages', 1, 'content', 0, 'content', 1] });
  assert.match(details.media_context, /paper\.pdf/);
  assert.match(details.media_context, /PDF 頁面圖 2\/2/);
  assert.match(details.media_context, /頁 6/);
  delete messages[0].content[0].input.pages;
  const unknown = createMediaProgressTracker(messages).timelineDetails({ phase: 'image_vision', path: ['messages', 1, 'content', 0, 'content', 1] });
  assert.doesNotMatch(unknown.media_context, /頁 6|頁 2(?:\s|$)/);
});

test('V0.29.68 media, heartbeat, model and final handoff share one inline timeline and one clock', async t => {
  const { res, progress } = stream(t);
  const tracker = createMediaProgressTracker(body());
  await progress.open();
  await progress.update('old PDF start', { details: tracker.timelineDetails({ phase: 'pdf_start', path: mediaPath, timeline_elapsed_ms: 0 }) });
  const start = progress.modelTimeline.startedAt;
  await progress.update('old PDF classify', { details: tracker.timelineDetails({ phase: 'pdf_classify', path: mediaPath, completed: 2, total: 4, timeline_elapsed_ms: 3000 }) });
  await progress.update('old heartbeat', { kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('ready', { details: tracker.timelineDetails({ phase: 'media_ready', timeline_elapsed_ms: 11000 }) });
  await progress.update('start model', { details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: start + 12000, timeline_elapsed_ms: 12000 } });
  await progress.update('thinking', { details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 15000 } });
  await progress.closeProgress('finished', { phase: 'handoff_to_claude_code', details: { tool_names: ['Read'], timeline_elapsed_ms: 16000 } });
  const text = deltas(res).filter(d => d !== '\n\n').join('');
  assert.equal((text.match(/處理中 · /g) || []).length, 1);
  assert.doesNotMatch(text, /模型處理中|old |\n|狀態：/);
  assert.match(text, /board\.pdf/);
  assert.match(text, /3s ◇ 分類.*頁 2\/4.* \|.*11s ◇ 媒體就緒.*12s ○.*15s ◐.*16s 已產生下一步 Read/);
  assert.equal((text.match(/board\.pdf/g) || []).length, 1, 'do not repeat filename for every stage');
  assert.equal(progress.modelTimeline.startedAt, start, 'main model must not reset the media clock');
  assert.equal(events(res).filter(e => e.type === 'content_block_start').length, 1);
  assert.equal(events(res).filter(e => e.type === 'content_block_stop').length, 1);
});

test('V0.29.68 duplicate media states do not flood the timeline; separate sources remain distinct', async t => {
  const { res, progress } = stream(t);
  const messages = body('image', 'same.png');
  messages[0].content.push({ ...messages[0].content[0] });
  const tracker = createMediaProgressTracker(messages);
  await progress.open();
  for (const suffix of ['a', 'b']) await progress.update(suffix, { details: tracker.timelineDetails({ phase: 'image_vision', path: mediaPath }) });
  await progress.update('c', { details: tracker.timelineDetails({ phase: 'image_vision', path: ['messages', 0, 'content', 1] }) });
  const text = deltas(res).join('');
  assert.equal((text.match(/視覺判讀/g) || []).length, 2);
  assert.match(text, /圖片 1\/2/);
  assert.match(text, /圖片 2\/2/);
});

test('V0.29.68 unknown media events and partial directed results remain observable but not falsely complete', async t => {
  const { res, progress } = stream(t);
  const tracker = createMediaProgressTracker(body('image'));
  await progress.open();
  await progress.update('untrusted output\nSECRET', { details: tracker.timelineDetails({ phase: 'pdf_future_stage', path: mediaPath }) });
  await progress.update('succeeded', { details: tracker.timelineDetails({ phase: 'directed_perception_completed', path: mediaPath, status: 'partial' }) });
  const text = deltas(res).join('');
  assert.match(text, /處理/);
  assert.match(text, /⚠.*部分可讀/);
  assert.doesNotMatch(text, /SECRET|succeeded|判讀完成|\n/);
});

test('V0.29.68 locale selection applies to media timeline labels', () => {
  for (const [locale, expected] of [['en-US', 'Analyzing'], ['zh-CN', '视觉判读'], ['ja-JP', '視覚解析'], ['ko-KP', '시각 분석']]) {
    const detail = createMediaProgressTracker(body('image'), { locale }).timelineDetails({ phase: 'image_vision', path: mediaPath });
    assert.equal(detail.media_label, expected);
  }
});

test('V0.29.68 media force does not bypass visibility gate, nor leak a completed fast request', async t => {
  const { res, progress } = stream(t, { visibleAfterMs: 60000 });
  const tracker = createMediaProgressTracker(body());
  await progress.open();
  await progress.update('parse', { force: true, details: tracker.timelineDetails({ phase: 'pdf_start', path: mediaPath }) });
  assert.equal(deltas(res).length, 0);
  await progress.closeProgress('done', { phase: 'returning_visible_response' });
  await progress.stop();
  assert.equal(deltas(res).length, 0);
  assert.equal(progress.pendingUpdates.length, 0);
});

test('V0.29.68 subagent remains ping-only during media and no progress is added after close', async t => {
  const { res, progress } = stream(t, { visibleProgressEnabled: false });
  const tracker = createMediaProgressTracker(body());
  await progress.open();
  await progress.update('parse', { details: tracker.timelineDetails({ phase: 'pdf_start', path: mediaPath }) });
  await progress.closeProgress('done');
  await progress.update('late', { details: tracker.timelineDetails({ phase: 'pdf_complete', path: mediaPath }) });
  assert.equal(deltas(res).length, 0);
  assert.ok(events(res).some(e => e.type === 'ping'));
});

test('V0.29.68 unified media progress is stripped from history without removing the real answer', async t => {
  const { res, progress } = stream(t);
  const tracker = createMediaProgressTracker(body());
  await progress.open();
  await progress.update('parse', { details: tracker.timelineDetails({ phase: 'pdf_start', path: mediaPath }) });
  const history = [{ role: 'assistant', content: [{ type: 'text', text: deltas(res).join('') }, { type: 'text', text: 'real answer' }] }];
  assert.deepEqual(stripProgressHistory(history)[0].content, [{ type: 'text', text: 'real answer' }]);
});

test('V0.29.68 focused PDF documents keep their requested page scope in the short source label', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r42', name: 'Read', input: { file_path: '/private/board.pdf', pages: '42-43' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r42', content: [body()[0].content[0]] }] },
  ];
  const details = createMediaProgressTracker(messages).timelineDetails({ phase: 'pdf_start', path: ['messages', 1, 'content', 0, 'content', 0] });
  assert.match(details.media_context, /頁 42-43/);
});
