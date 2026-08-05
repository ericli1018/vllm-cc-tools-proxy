import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { HttpError, readJsonBody } from '../src/lib/http.js';

function requestFrom(chunks) {
  const req = Readable.from(chunks);
  req.headers = {};
  return req;
}

test('readJsonBody parses a bounded JSON request', async () => {
  const result = await readJsonBody(requestFrom(['{"ok":', 'true}']), 1024);
  assert.deepEqual(result, { ok: true });
});

test('readJsonBody rejects invalid JSON as 400', async () => {
  await assert.rejects(
    readJsonBody(requestFrom(['{bad']), 1024),
    (error) => error instanceof HttpError && error.status === 400,
  );
});

test('readJsonBody rejects oversized bodies as 413', async () => {
  await assert.rejects(
    readJsonBody(requestFrom(['123456']), 5),
    (error) => error instanceof HttpError && error.status === 413,
  );
});

import { EventEmitter } from 'node:events';
import { writeChunk } from '../src/lib/http.js';

test('writeChunk times out when backpressure never drains', async () => {
  class BlockedResponse extends EventEmitter {
    write() { return false; }
  }
  await assert.rejects(
    writeChunk(new BlockedResponse(), 'chunk', { drainTimeoutMs: 10 }),
    (error) => error instanceof HttpError && error.code === 'sse_drain_timeout',
  );
});

test('writeChunk returns bytes and backpressure timing after drain', async () => {
  class DrainingResponse extends EventEmitter {
    write() { setTimeout(() => this.emit('drain'), 5); return false; }
  }
  const result = await writeChunk(new DrainingResponse(), 'abc', { drainTimeoutMs: 100 });
  assert.equal(result.bytes, 3);
  assert.equal(result.backpressure, true);
  assert.ok(result.waitedMs >= 0);
});
