import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedQueue } from '../src/concurrency/managed-queue.js';
import { Semaphore } from '../src/concurrency/semaphore.js';
import { AdmissionController } from '../src/concurrency/admission-controller.js';

async function expectPending(promise, ms = 20) {
  const marker = Symbol('pending');
  assert.equal(await Promise.race([promise.then(() => 'settled', () => 'settled'), delay(ms, marker)]), marker);
}

test('managed queue admits immediately up to limit and preserves FIFO order', async () => {
  const queue = new ManagedQueue({ limit: 1, queueLimit: 3, timeoutMs: 1000 });
  const releaseA = await queue.acquire({ requestId: 'A' });
  const order = [];
  const b = queue.acquire({ requestId: 'B' }).then((release) => { order.push('B'); return release; });
  const c = queue.acquire({ requestId: 'C' }).then((release) => { order.push('C'); return release; });
  await expectPending(b);
  await expectPending(c);
  assert.deepEqual(queue.health(), { active: 1, limit: 1, queued: 2, queueLimit: 3 });
  releaseA();
  const releaseB = await b;
  assert.deepEqual(order, ['B']);
  releaseB();
  const releaseC = await c;
  assert.deepEqual(order, ['B', 'C']);
  releaseC();
  assert.deepEqual(queue.health(), { active: 0, limit: 1, queued: 0, queueLimit: 3 });
});

test('managed queue rejects new jobs when waiting capacity is full', async () => {
  const queue = new ManagedQueue({ limit: 1, queueLimit: 1, timeoutMs: 1000 });
  const release = await queue.acquire({ requestId: 'A' });
  const waiting = queue.acquire({ requestId: 'B' });
  await assert.rejects(queue.acquire({ requestId: 'C' }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'proxy_queue_full');
    assert.equal(error.retryable, true);
    return true;
  });
  release();
  (await waiting)();
});

test('managed queue times out without executing the job', async () => {
  const queue = new ManagedQueue({ limit: 1, queueLimit: 1, timeoutMs: 30 });
  const release = await queue.acquire({ requestId: 'A' });
  await assert.rejects(queue.acquire({ requestId: 'B' }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'proxy_queue_timeout');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(queue.health().queued, 0);
  release();
});

test('cancelling a queued job removes it and admits the next valid job', async () => {
  const queue = new ManagedQueue({ limit: 1, queueLimit: 3, timeoutMs: 1000 });
  const releaseA = await queue.acquire({ requestId: 'A' });
  const controller = new AbortController();
  const b = queue.acquire({ requestId: 'B', signal: controller.signal });
  const c = queue.acquire({ requestId: 'C' });
  controller.abort();
  await assert.rejects(b, (error) => error.name === 'AbortError');
  assert.equal(queue.health().queued, 1);
  releaseA();
  const releaseC = await c;
  releaseC();
});

test('queue position callback receives enqueue and updated positions', async () => {
  const queue = new ManagedQueue({ limit: 1, queueLimit: 3, timeoutMs: 1000 });
  const releaseA = await queue.acquire({ requestId: 'A' });
  const positionsB = [];
  const positionsC = [];
  const b = queue.acquire({ requestId: 'B', onPosition: (position) => positionsB.push(position) });
  const c = queue.acquire({ requestId: 'C', onPosition: (position) => positionsC.push(position) });
  await delay(5);
  assert.deepEqual(positionsB, [1]);
  assert.deepEqual(positionsC, [2]);
  releaseA();
  const releaseB = await b;
  await delay(5);
  assert.deepEqual(positionsC, [2, 1]);
  releaseB();
  (await c)();
});

test('release is idempotent and slots are not leaked when work throws', async () => {
  const queue = new ManagedQueue({ limit: 1, queueLimit: 1, timeoutMs: 1000 });
  const release = await queue.acquire({ requestId: 'A' });
  release();
  release();
  const next = await queue.acquire({ requestId: 'B' });
  next();
  assert.equal(queue.health().active, 0);
});

test('semaphore serializes visual calls and supports cancellation', async () => {
  const semaphore = new Semaphore(1);
  const releaseA = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire({ signal: controller.signal });
  await expectPending(waiting);
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  releaseA();
  const releaseB = await semaphore.acquire();
  releaseB();
  assert.deepEqual(semaphore.health(), { active: 0, limit: 1, queued: 0 });
});

test('admission controller exposes managed and vision health', async () => {
  const admission = new AdmissionController({ managedLimit: 2, queueLimit: 4, queueTimeoutMs: 1000, visionLimit: 1 });
  const releaseManaged = await admission.acquireManaged({ requestId: 'A' });
  const releaseVision = await admission.acquireVision();
  assert.deepEqual(admission.health(), {
    managed: { active: 1, limit: 2, queued: 0, queueLimit: 4 },
    vision: { active: 1, limit: 1, queued: 0 },
  });
  releaseVision();
  releaseManaged();
});
