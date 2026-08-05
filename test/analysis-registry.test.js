import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaAnalysisRegistry } from '../src/media/analysis-registry.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('singleflight shares one analysis across concurrent callers', async () => {
  const registry = new MediaAnalysisRegistry();
  let calls = 0;
  const producer = async () => { calls += 1; await delay(20); return { text: 'done' }; };
  const [a, b] = await Promise.all([
    registry.run('same', producer),
    registry.run('same', producer),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { text: 'done' });
  assert.deepEqual(b, { text: 'done' });
  assert.equal(registry.health().inflight_analyses, 0);
});

test('cancelling one waiter does not abort analysis needed by another waiter', async () => {
  const registry = new MediaAnalysisRegistry();
  const controller = new AbortController();
  let sharedAborted = false;
  const producer = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { sharedAborted = true; reject(signal.reason); }, { once: true });
    setTimeout(() => resolve('result'), 25);
  });
  const first = registry.run('same', producer, { signal: controller.signal });
  const second = registry.run('same', producer);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(first, /cancelled/);
  assert.equal(await second, 'result');
  assert.equal(sharedAborted, false);
});

test('all cancelled waiters abort the shared analysis', async () => {
  const registry = new MediaAnalysisRegistry();
  const a = new AbortController();
  const b = new AbortController();
  let aborted = false;
  const producer = ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  const first = registry.run('same', producer, { signal: a.signal });
  const second = registry.run('same', producer, { signal: b.signal });
  a.abort(new DOMException('a', 'AbortError'));
  b.abort(new DOMException('b', 'AbortError'));
  await assert.rejects(first);
  await assert.rejects(second);
  await delay(0);
  assert.equal(aborted, true);
});
