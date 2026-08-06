import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProtocolDiagnosticStore } from '../src/proxy/protocol-diagnostic-store.js';

async function withTempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcc-protocol-store-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('ProtocolDiagnosticStore atomically writes a timestamped private JSON bundle', async (t) => {
  const rootDir = await withTempDir(t);
  const store = new ProtocolDiagnosticStore({
    rootDir,
    now: () => new Date('2026-08-06T07:48:27.545Z'),
    randomId: () => 'abc12345',
  });
  const result = await store.write({
    request_id: '507e5d7e-121b-4c92-8283-8783bb594e3d',
    round: 2,
    repair: false,
    reasons: ['final_answer_in_thinking'],
    output_snippets: [{ reason: 'final_answer_in_thinking', full_text_redacted: 'complete answer' }],
    input_snippets: [],
  });

  assert.match(path.basename(result.file_path), /^20260806T074827\.545Z__507e5d7e-121b-4c92-8283-8783bb594e3d__r02__original__abc12345\.json$/);
  const raw = await fs.readFile(result.file_path);
  assert.equal(result.file_bytes, raw.length);
  assert.equal(result.file_sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  const payload = JSON.parse(raw.toString('utf8'));
  assert.equal(payload.schema_version, 'vcc-protocol-diagnostic-v1');
  assert.equal(payload.created_at, '2026-08-06T07:48:27.545Z');
  assert.equal(payload.request_id, '507e5d7e-121b-4c92-8283-8783bb594e3d');
  assert.equal(payload.phase, 'original_response');
  assert.equal(payload.output_snippets[0].full_text_redacted, 'complete answer');

  const names = await fs.readdir(rootDir);
  assert.deepEqual(names, [path.basename(result.file_path)]);
  const fileMode = (await fs.stat(result.file_path)).mode & 0o777;
  const dirMode = (await fs.stat(rootDir)).mode & 0o777;
  assert.equal(fileMode, 0o600);
  assert.equal(dirMode, 0o700);
});

test('ProtocolDiagnosticStore sanitizes filename components and separates repair files', async (t) => {
  const rootDir = await withTempDir(t);
  const store = new ProtocolDiagnosticStore({
    rootDir,
    now: () => new Date('2026-08-06T07:48:27.545Z'),
    randomId: () => 'ffff0000',
  });
  const result = await store.write({
    request_id: '../unsafe request/id',
    round: 123,
    repair: true,
    reasons: [],
    output_snippets: [],
    input_snippets: [],
  });
  assert.match(path.basename(result.file_path), /^20260806T074827\.545Z__unsafe-request-id__r99__repair__ffff0000\.json$/);
  assert.equal(path.dirname(result.file_path), rootDir);
});
