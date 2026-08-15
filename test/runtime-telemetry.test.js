import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeTelemetry } from '../src/proxy/runtime-telemetry.js';

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms) { now += ms; },
  };
}

test('V0.2.28.17 RuntimeTelemetry exposes bounded per-session semantic byte rate', () => {
  const time = clock();
  const telemetry = new RuntimeTelemetry({ clock: time.now });
  const release = telemetry.beginRequest({ requestId: 'r1', sessionId: 's1' });

  telemetry.updateRequest('r1', { phase: 'thinking' });
  telemetry.observeModelDelta('r1', 1024);
  time.advance(1000);
  telemetry.observeModelDelta('r1', 1024);
  time.advance(500);

  const snapshot = telemetry.snapshotSession('s1');
  assert.equal(snapshot.known, true);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.requestId, 'r1');
  assert.equal(snapshot.phase, 'thinking');
  assert.equal(snapshot.elapsedMs, 1500);
  assert.equal(snapshot.receivedBytes, 2048);
  assert.ok(snapshot.throughputBps > 0);
  assert.equal(snapshot.pulseIndex, 1);

  release();
  const idle = telemetry.snapshotSession('s1');
  assert.equal(idle.known, true);
  assert.equal(idle.active, false);
  assert.equal(idle.phase, 'idle');
});

test('V0.2.28.16 RuntimeTelemetry never returns prompt or response content fields', () => {
  const telemetry = new RuntimeTelemetry();
  const release = telemetry.beginRequest({ requestId: 'r-secret', sessionId: 's-secret' });
  telemetry.updateRequest('r-secret', { phase: 'response', toolName: 'Edit' });
  const serialized = JSON.stringify(telemetry.snapshotSession('s-secret'));
  release();
  assert.doesNotMatch(serialized, /prompt|message|content|responseText|toolInput/i);
});

test('V0.2.28.17 RuntimeTelemetry counts semantic model bytes and rolling rate decays to zero', () => {
  const time = clock();
  const telemetry = new RuntimeTelemetry({ clock: time.now, throughputWindowMs: 5000 });
  const release = telemetry.beginRequest({ requestId: 'r-semantic', sessionId: 's-semantic' });
  telemetry.updateRequest('r-semantic', { phase: 'thinking' });

  telemetry.observeModelDelta('r-semantic', 100);
  time.advance(1000);
  telemetry.observeModelDelta('r-semantic', 200);

  let snapshot = telemetry.snapshotSession('s-semantic');
  assert.equal(snapshot.receivedBytes, 300);
  assert.ok(snapshot.throughputBps > 0);
  assert.equal(snapshot.wireBytes, undefined);

  time.advance(5100);
  snapshot = telemetry.snapshotSession('s-semantic');
  assert.equal(snapshot.receivedBytes, 300);
  assert.equal(snapshot.throughputBps, 0);

  release();
});

test('V0.2.28.19 current model round resets bytes throughput and elapsed between rounds', () => {
  const time = clock(10_000);
  const telemetry = new RuntimeTelemetry({ clock: time.now, throughputWindowMs: 5000 });
  const release = telemetry.beginRequest({ requestId: 'r-round', sessionId: 's-round' });

  telemetry.beginModelRound('r-round', { round: 1, startedAt: time.now() });
  telemetry.updateRequest('r-round', { phase: 'thinking' });
  telemetry.observeModelDelta('r-round', 1000);
  time.advance(2000);
  let snapshot = telemetry.snapshotSession('s-round');
  assert.equal(snapshot.round, 1);
  assert.equal(snapshot.receivedBytes, 1000);
  assert.equal(snapshot.elapsedMs, 2000);
  assert.ok(snapshot.throughputBps > 0);

  telemetry.endModelRound('r-round', { endedAt: time.now() });
  time.advance(3000);
  telemetry.beginModelRound('r-round', { round: 2, startedAt: time.now() });
  snapshot = telemetry.snapshotSession('s-round');
  assert.equal(snapshot.round, 2);
  assert.equal(snapshot.receivedBytes, 0);
  assert.equal(snapshot.throughputBps, 0);
  assert.equal(snapshot.elapsedMs, 0);

  time.advance(1200);
  telemetry.observeModelDelta('r-round', 250);
  snapshot = telemetry.snapshotSession('s-round');
  assert.equal(snapshot.receivedBytes, 250);
  assert.equal(snapshot.elapsedMs, 1200);
  assert.ok(snapshot.throughputBps > 0);

  release();
});

test('V0.2.28.19 non-model phases do not expose stale previous-round bytes or throughput', () => {
  const time = clock(20_000);
  const telemetry = new RuntimeTelemetry({ clock: time.now, throughputWindowMs: 5000 });
  const release = telemetry.beginRequest({ requestId: 'r-lang', sessionId: 's-lang' });
  telemetry.beginModelRound('r-lang', { round: 1, startedAt: time.now() });
  telemetry.updateRequest('r-lang', { phase: 'response' });
  telemetry.observeModelDelta('r-lang', 2048);
  time.advance(1000);
  telemetry.endModelRound('r-lang', { endedAt: time.now() });
  telemetry.updateRequest('r-lang', { phase: 'language', detail: 'external:zh-TW' });

  const snapshot = telemetry.snapshotSession('s-lang');
  assert.equal(snapshot.phase, 'language');
  assert.equal(snapshot.receivedBytes, 0);
  assert.equal(snapshot.throughputBps, 0);
  assert.equal(snapshot.roundActive, false);

  release();
});


test('V0.29.20 session status is owned by Main request while Sub Agent still counts as active work', () => {
  const time = clock(50_000);
  const telemetry = new RuntimeTelemetry({ clock: time.now });
  const releaseMain = telemetry.beginRequest({ requestId: 'main-r', sessionId: 'shared-s', agentContext: 'main' });
  telemetry.beginModelRound('main-r', { round: 1, startedAt: time.now() });
  telemetry.updateRequest('main-r', { phase: 'thinking' });
  telemetry.observeModelDelta('main-r', 100);

  time.advance(1000);
  const releaseSub = telemetry.beginRequest({ requestId: 'sub-r', sessionId: 'shared-s', agentContext: 'subagent' });
  telemetry.beginModelRound('sub-r', { round: 1, startedAt: time.now() });
  telemetry.updateRequest('sub-r', { phase: 'response' });
  telemetry.observeModelDelta('sub-r', 999);

  const status = telemetry.snapshotSession('shared-s');
  assert.equal(status.requestId, 'main-r');
  assert.equal(status.agentContext, 'main');
  assert.equal(status.phase, 'thinking');
  assert.equal(status.receivedBytes, 100);
  assert.deepEqual(telemetry.snapshot(), { uptimeMs: 1000, sessions: 1, active: 2, waiting: 0 });

  releaseMain();
  const afterMain = telemetry.snapshotSession('shared-s');
  assert.equal(afterMain.active, false);
  assert.equal(afterMain.phase, 'idle');
  assert.equal(afterMain.lastPhase, 'thinking');

  releaseSub();
});

test('V0.29.20 Sub Agent state never overwrites remembered Main session state', () => {
  const time = clock(80_000);
  const telemetry = new RuntimeTelemetry({ clock: time.now });
  const releaseMain = telemetry.beginRequest({ requestId: 'main-r2', sessionId: 'shared-s2', agentContext: 'main' });
  telemetry.updateRequest('main-r2', { phase: 'tool', toolName: 'Agent' });
  releaseMain();

  const releaseSub = telemetry.beginRequest({ requestId: 'sub-r2', sessionId: 'shared-s2', agentContext: 'subagent' });
  telemetry.updateRequest('sub-r2', { phase: 'thinking' });
  const duringSub = telemetry.snapshotSession('shared-s2');
  assert.equal(duringSub.active, false);
  assert.equal(duringSub.phase, 'idle');
  assert.equal(duringSub.lastPhase, 'tool');
  releaseSub();

  const afterSub = telemetry.snapshotSession('shared-s2');
  assert.equal(afterSub.lastPhase, 'tool');
});
