import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ProgressStream, hasProgressHistory, stripProgressHistory } from '../src/proxy/progress.js';
import { emitFinalAnthropicResponse } from '../src/proxy/anthropic-sse.js';
import { SUPPORTED_RESPONSE_LANGUAGES, modelTimelineHeader, progressBlockHeader, statusText } from '../src/i18n/response-language.js';

class FakeResponse extends EventEmitter {
  constructor() { super(); this.chunks = []; }
  writeHead() {}
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end() {}
}
function events(res) {
  return res.chunks.join('').split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
function deltas(res) {
  return events(res).filter(e => e.type === 'content_block_delta').map(e => e.delta.text ?? e.delta.thinking ?? '');
}
function setup(t, options = {}) {
  const res = new FakeResponse();
  const changes = [];
  const progress = new ProgressStream(res, { visibleAfterMs: 0, pingIntervalMs: 60000, locale: 'zh-TW', onStateChange: e => changes.push(e), ...options });
  t.after(() => progress.dispose());
  return { res, progress, changes };
}
const start = { phase: 'managed_model_round_start', model_timeline: true, round: 1, model_started_at: 1 };
const phase = (name, ms) => ({ phase: 'model_stream_phase', model_timeline: true, model_phase: name, timeline_elapsed_ms: ms });

for (const locale of SUPPORTED_RESPONSE_LANGUAGES) for (const carrier of ['text', 'thinking']) {
  test(`V0.29.70 ${locale}/${carrier}: diagnostic planning never precedes the single timeline`, async t => {
    const { res, progress, changes } = setup(t, { locale, carrier });
    await progress.open();
    const planning = statusText(locale, 'modelPlanning');
    // This is the exact two-callback order used by runManagedLoop + onModelRoundState.
    await progress.update(planning, { details: { phase: 'managed_model_round_start', round: 1 } });
    await progress.update(planning, { details: start });
    await progress.update('waiting sample 1', { kind: 'semantic_heartbeat' });
    await progress.update('waiting sample 2', { kind: 'semantic_heartbeat' });
    await progress.update('old thinking', { details: phase('thinking', 75000) });
    await progress.update('old responding', { details: phase('response', 77000) });
    await progress.update('old tools', { details: phase('tool', 78000) });
    await progress.closeProgress('handoff', { phase: 'handoff_to_claude_code', details: { tool_names: ['Read'], timeline_elapsed_ms: 78000 } });
    const text = deltas(res).filter(d => d !== '\n\n').join('');
    const prefix = modelTimelineHeader(locale, { timestampMs: 1 });
    assert.equal(text, `${prefix} ○ || 75s ◐ 77s ◆ 78s ◇ 78s ${statusText(locale, 'timelineHandoffSingle', { tool: 'Read' })}`);
    assert.ok(!text.includes(planning));
    assert.ok(!text.includes(progressBlockHeader(locale).split(' · ')[0]));
    assert.doesNotMatch(text, /\n|old |waiting sample/);
    assert.equal(events(res).filter(e => e.type === 'content_block_start').length, 1);
    assert.equal(events(res).filter(e => e.type === 'content_block_stop').length, 1);
    assert.equal(events(res).find(e => e.type === 'content_block_start').content_block.type, carrier);
    assert.equal(changes[0].message, planning, 'keep diagnostic state even when its old visible copy is suppressed');
  });
}

test('V0.29.70 delayed flush cannot revive old notices queued before the model timeline', async t => {
  const { res, progress } = setup(t, { visibleAfterMs: 40 });
  await progress.open();
  await progress.update('正在請模型規劃下一步…', { force: true, details: { phase: 'managed_model_round_start', round: 1 } });
  await progress.update('start', { details: { ...start, model_started_at: Date.now() } });
  await progress.update('thinking', { details: phase('thinking', 1000) });
  assert.equal(deltas(res).length, 0);
  await new Promise(resolve => setTimeout(resolve, 70));
  await progress.closeProgress();
  const text = deltas(res).filter(d => d !== '\n\n').join('');
  assert.match(text, /^處理中 · \d{2}:\d{2}:\d{2} ○ 1s ◐$/);
  assert.equal(progress.pendingUpdates.length, 0);
});

test('V0.29.70 all unstructured legacy statuses remain diagnostic-only, even with force', async t => {
  let hookCalls = 0;
  const { res, progress, changes } = setup(t, { onBeforeFirstVisible: () => hookCalls++ });
  await progress.open();
  for (const [key, name] of [
    ['modelPlanning', 'managed_model_round_start'], ['modelToolResults', 'managed_model_round_start'],
    ['baseHeadersReceived', 'base_headers_received'], ['upstreamBusyRetry', 'upstream_busy_retry'],
    ['upstreamBusyAccepted', 'upstream_busy_accepted'], ['modelStallRecovery', 'managed_model_stall_recovery'],
    ['finalLanguageRepair', 'final_language_repair'], ['mediaReady', 'media_ready'],
  ]) await progress.update(statusText('zh-TW', key, { attempt: 1, total: 2 }), { force: true, details: { phase: name } });
  await progress.update('arbitrary\nlegacy status', { force: true });
  await progress.update('legacy heartbeat', { kind: 'semantic_heartbeat', force: true });
  await progress.closeProgress('old final line');
  assert.equal(deltas(res).length, 0);
  assert.equal(events(res).filter(e => e.type === 'content_block_start').length, 0);
  assert.ok(changes.length >= 8);
  assert.equal(progress.pendingUpdates.length, 0);
  assert.equal(progress.pendingTimer, null);
  assert.equal(hookCalls, 0, 'a suppressed status must not trigger startup visibility');
});

test('V0.29.70 visible model wording is preserved in the actual upstream answer', async t => {
  const { res, progress } = setup(t);
  await progress.open();
  await progress.update('正在請模型規劃下一步…', { details: { phase: 'managed_model_round_start' } });
  await progress.update('start', { details: start });
  await progress.update('thinking', { details: phase('thinking', 1000) });
  await progress.closeProgress();
  const answer = '請移除以下舊提示：\n模型處理中 · 11:38:29\n正在請模型規劃下一步…';
  await emitFinalAnthropicResponse(progress, { id: 'final', role: 'assistant', type: 'message', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 10 } });
  assert.ok(deltas(res).includes(answer));
  assert.equal(events(res).filter(e => e.type === 'message_stop').length, 1);
});

test('V0.29.70 legacy and new progress history stays removable without filtering normal answer text', () => {
  const answer = { type: 'text', text: '請移除「模型處理中」與「正在請模型規劃下一步」。' };
  for (const locale of SUPPORTED_RESPONSE_LANGUAGES) for (const header of [progressBlockHeader(locale), modelTimelineHeader(locale)]) {
    const history = [{ role: 'assistant', content: [{ type: 'text', text: `${header}\nold or new progress` }, answer] }];
    assert.equal(hasProgressHistory(history), true);
    assert.deepEqual(stripProgressHistory(history)[0].content, [answer]);
  }
});
