import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('V0.29.12 disposed ProgressStream is collectible after timer and response references are released', () => {
  const script = String.raw`
    import { EventEmitter } from 'node:events';
    import { ProgressStream } from './src/proxy/progress.js';
    class FakeResponse extends EventEmitter {
      writeHead() {}
      write() { return true; }
    }
    let progress = new ProgressStream(new FakeResponse(), {
      visibleAfterMs: 60000,
      pingIntervalMs: 60000,
      heartbeatIntervalMs: 60000,
    });
    await progress.open();
    await progress.update('pending', { details: { phase: 'pending' } });
    progress.startSemanticHeartbeat(() => 'heartbeat');
    const ref = new WeakRef(progress);
    await progress.dispose();
    progress = null;
    for (let i = 0; i < 40 && ref.deref(); i += 1) {
      global.gc();
      // Force the next GC into a later job and add modest allocation pressure.
      await new Promise((resolve) => setImmediate(resolve));
      const pressure = new Array(10000).fill('x'.repeat(32));
      void pressure;
    }
    global.gc();
    await new Promise((resolve) => setImmediate(resolve));
    process.stdout.write(ref.deref() ? 'retained' : 'collected');
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'collected');
});
