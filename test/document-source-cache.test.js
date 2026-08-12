import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DocumentSourceCache } from '../src/cache/document-source-cache.js';

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

test('V0.29.0 document source cache persists original PDF by opaque Read source reference', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcc-doc-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new DocumentSourceCache({ rootDir: root, retentionMs: 60_000 });
  await cache.initialize();
  const buffer = Buffer.from('%PDF-1.7\nORIGINAL SOURCE');
  const sourceSha256 = sha(buffer);
  assert.equal(await cache.put({ readSourceRef: 'a'.repeat(64), sourceSha256, buffer, filename: 'board.pdf' }), true);
  const resolved = await cache.resolve('a'.repeat(64));
  assert.equal(resolved.sourceSha256, sourceSha256);
  assert.equal(resolved.filename, 'board.pdf');
  assert.deepEqual(resolved.buffer, buffer);
  assert.doesNotMatch(resolved.sourcePath, /board\.pdf$/i, 'persistent filename must not expose the Claude Code source path/name');
});

test('V0.29.0 document source cache updates a source reference when the file content changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcc-doc-source-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new DocumentSourceCache({ rootDir: root, retentionMs: 60_000 });
  await cache.initialize();
  const first = Buffer.from('%PDF-1.7\nFIRST');
  const second = Buffer.from('%PDF-1.7\nSECOND');
  await cache.put({ readSourceRef: 'b'.repeat(64), sourceSha256: sha(first), buffer: first, filename: 'manual.pdf' });
  await cache.put({ readSourceRef: 'b'.repeat(64), sourceSha256: sha(second), buffer: second, filename: 'manual.pdf' });
  const resolved = await cache.resolve('b'.repeat(64));
  assert.equal(resolved.sourceSha256, sha(second));
  assert.deepEqual(resolved.buffer, second);
});
