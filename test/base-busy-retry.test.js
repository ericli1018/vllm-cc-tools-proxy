import test from 'node:test';
import assert from 'node:assert/strict';
import { isExplicitVllmBusyResponse, waitForRetry } from '../src/services/base-busy-retry.js';

function response(status, headers = {}) {
  return { status, headers: { get: (name) => headers[String(name).toLowerCase()] ?? null } };
}

test('429 is always classified as explicit upstream busy', () => {
  assert.equal(isExplicitVllmBusyResponse(response(429), '{"error":{"message":"rate limited"}}'), true);
});

test('503 requires an explicit transient capacity signal', () => {
  assert.equal(isExplicitVllmBusyResponse(response(503), '{"error":{"message":"server overloaded: no available capacity"}}'), true);
  assert.equal(isExplicitVllmBusyResponse(response(503, { 'retry-after': '15' }), '{"error":{"message":"generic unavailable"}}'), true);
  assert.equal(isExplicitVllmBusyResponse(response(503), '{"error":{"message":"tensor initialization failed"}}'), false);
});

test('busy retry wait aborts immediately with the connection signal', async () => {
  const controller = new AbortController();
  const waiting = waitForRetry(1000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
});
