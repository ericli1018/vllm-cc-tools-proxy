import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Semaphore } from '../src/concurrency/semaphore.js';
import { AdmissionController } from '../src/concurrency/admission-controller.js';

async function expectPending(promise, ms = 20) {
  const marker = Symbol('pending');
  assert.equal(await Promise.race([promise.then(() => 'settled', () => 'settled'), delay(ms, marker)]), marker);
}

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

test('admission controller only protects auxiliary Vision and WebFetch Processor resources', async () => {
  const admission = new AdmissionController({ visionLimit: 1, webFetchProcessorLimit: 3 });
  const releaseVision = await admission.acquireVision();
  const releaseProcessor = await admission.acquireWebFetchProcessor();
  assert.deepEqual(admission.health(), {
    vision: { active: 1, limit: 1, queued: 0 },
    webFetchProcessor: { active: 1, limit: 3, queued: 0 },
  });
  assert.equal(typeof admission.acquireManaged, 'undefined');
  assert.equal(typeof admission.acquireLargeContext, 'undefined');
  assert.equal(typeof admission.acquireNativeWebSearch, 'undefined');
  releaseProcessor();
  releaseVision();
});

test('WebFetch Processor admission allows three global model calls and queues the fourth', async () => {
  const admission = new AdmissionController({ visionLimit: 1, webFetchProcessorLimit: 3 });
  const releases = await Promise.all([
    admission.acquireWebFetchProcessor(),
    admission.acquireWebFetchProcessor(),
    admission.acquireWebFetchProcessor(),
  ]);
  const fourth = admission.acquireWebFetchProcessor();
  await expectPending(fourth);
  assert.deepEqual(admission.health().webFetchProcessor, { active: 3, limit: 3, queued: 1 });
  releases[0]();
  const releaseFourth = await fourth;
  assert.deepEqual(admission.health().webFetchProcessor, { active: 3, limit: 3, queued: 0 });
  releaseFourth();
  releases[1]();
  releases[2]();
  assert.deepEqual(admission.health().webFetchProcessor, { active: 0, limit: 3, queued: 0 });
});
