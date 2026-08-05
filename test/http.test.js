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
