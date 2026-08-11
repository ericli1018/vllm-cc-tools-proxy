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

test('V0.2.28.16 RuntimeTelemetry exposes bounded per-session request phase and rolling byte rate', () => {
  const time = clock();
  const telemetry = new RuntimeTelemetry({ clock: time.now });
  const release = telemetry.beginRequest({ requestId: 'r1', sessionId: 's1' });

  telemetry.updateRequest('r1', { phase: 'thinking' });
  telemetry.observeBytes('r1', 1024);
  time.advance(1000);
  telemetry.observeBytes('r1', 2048);
  time.advance(500);

  const snapshot = telemetry.snapshotSession('s1');
  assert.equal(snapshot.known, true);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.requestId, 'r1');
  assert.equal(snapshot.phase, 'thinking');
  assert.equal(snapshot.elapsedMs, 1500);
  assert.equal(snapshot.receivedBytes, 2048);
  assert.equal(snapshot.throughputBps, 1024);
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
