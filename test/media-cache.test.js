import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaCache } from '../src/cache/media-cache.js';

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('media cache persists normalized blocks across instances', async (t) => {
  const rootDir = await tempDir(t);
  const first = new MediaCache({ rootDir, maxBytes: 0, retentionMs: 60_000 });
  await first.initialize();
  assert.equal(await first.set('a'.repeat(64), { block: { type: 'text', text: 'cached markdown' }, metadata: { pages: 4 } }), true);

  const second = new MediaCache({ rootDir, maxBytes: 0, retentionMs: 60_000 });
  await second.initialize();
  const hit = await second.get('a'.repeat(64));
  assert.deepEqual(hit.block, { type: 'text', text: 'cached markdown' });
  assert.equal(hit.metadata.pages, 4);
  assert.equal(second.health().entries, 1);
});

test('expired entries are removed using last-used TTL', async (t) => {
  const rootDir = await tempDir(t);
  let now = 1_000;
  const cache = new MediaCache({ rootDir, maxBytes: 0, retentionMs: 100, clock: () => now });
  await cache.initialize();
  await cache.set('b'.repeat(64), { block: { type: 'text', text: 'old' } });
  now = 1_101;
  assert.equal(await cache.get('b'.repeat(64)), null);
  assert.equal(cache.health().entries, 0);
});

test('new cache writes sweep other expired entries without requiring restart', async (t) => {
  const rootDir = await tempDir(t);
  let now = 1_000;
  const cache = new MediaCache({ rootDir, maxBytes: 0, retentionMs: 100, clock: () => now });
  await cache.initialize();
  await cache.set('2'.repeat(64), { block: { type: 'text', text: 'old' } });
  now = 1_101;
  await cache.set('3'.repeat(64), { block: { type: 'text', text: 'new' } });
  assert.equal(cache.health().entries, 1);
  assert.equal(await cache.get('2'.repeat(64)), null);
  assert.ok(await cache.get('3'.repeat(64)));
});

test('bounded cache evicts least-recently-used entries', async (t) => {
  const rootDir = await tempDir(t);
  let now = 1_000;
  const cache = new MediaCache({ rootDir, maxBytes: 700, retentionMs: 60_000, clock: () => now });
  await cache.initialize();
  await cache.set('c'.repeat(64), { block: { type: 'text', text: 'a'.repeat(200) } });
  now += 1;
  await cache.set('d'.repeat(64), { block: { type: 'text', text: 'b'.repeat(200) } });
  assert.equal(await cache.get('c'.repeat(64)), null);
  assert.ok(await cache.get('d'.repeat(64)));
  assert.ok(cache.health().bytes <= 700);
});

test('zero capacity disables size eviction but keeps TTL behavior', async (t) => {
  const rootDir = await tempDir(t);
  const cache = new MediaCache({ rootDir, maxBytes: 0, retentionMs: 60_000 });
  await cache.initialize();
  await cache.set('e'.repeat(64), { block: { type: 'text', text: 'x'.repeat(2000) } });
  await cache.set('f'.repeat(64), { block: { type: 'text', text: 'y'.repeat(2000) } });
  assert.ok(await cache.get('e'.repeat(64)));
  assert.ok(await cache.get('f'.repeat(64)));
  assert.equal(cache.health().limit_mode, 'filesystem');
});

test('ENOSPC cache write degrades health without throwing', async (t) => {
  const rootDir = await tempDir(t);
  const fsImpl = {
    ...fs,
    writeFile: async (file, data, options) => {
      if (String(file).includes('.tmp-')) {
        const error = new Error('disk full'); error.code = 'ENOSPC'; throw error;
      }
      return fs.writeFile(file, data, options);
    },
  };
  const cache = new MediaCache({ rootDir, maxBytes: 0, retentionMs: 60_000, fsImpl });
  await cache.initialize();
  assert.equal(await cache.set('1'.repeat(64), { block: { type: 'text', text: 'result' } }), false);
  assert.equal(cache.health().write_available, false);
  assert.equal(cache.health().last_error, 'ENOSPC');
});

test('initialize removes incomplete atomic temporary files', async (t) => {
  const rootDir = await tempDir(t);
  await fs.writeFile(path.join(rootDir, '.tmp-incomplete'), 'partial');
  const cache = new MediaCache({ rootDir, maxBytes: 0, retentionMs: 60_000 });
  await cache.initialize();
  await assert.rejects(fs.stat(path.join(rootDir, '.tmp-incomplete')), /ENOENT/);
});
