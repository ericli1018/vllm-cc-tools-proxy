import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebToolDiagnosticTraceStore } from '../src/proxy/web-tool-diagnostic-trace-store.js';

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcc-webtrace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('WebToolDiagnosticTraceStore writes complete redacted payloads to private files and an index', async (t) => {
  const rootDir = await tempDir(t);
  const store = new WebToolDiagnosticTraceStore({
    rootDir,
    now: () => new Date('2026-08-07T13:53:00.123Z'),
    sessionId: 'diag-session',
  });
  const result = await store.write({
    request_id: 'req-1',
    event: 'client_request',
    direction: 'claude_code_to_proxy',
    metadata: { path: '/v1/messages' },
    payload: {
      headers: { authorization: 'Bearer super-secret', cookie: 'session=abc' },
      body: {
        messages: [{ role: 'user', content: 'search Taiwan news' }],
        tools: [{ name: 'WebSearch', description: 'normal description' }],
        api_key: 'sk-secret-secret',
      },
    },
  });

  const raw = await fs.readFile(result.file_path, 'utf8');
  const saved = JSON.parse(raw);
  assert.equal(saved.schema_version, 'vcc-web-tool-trace-v1');
  assert.equal(saved.event, 'client_request');
  assert.equal(saved.payload.headers.authorization, '[REDACTED]');
  assert.equal(saved.payload.headers.cookie, '[REDACTED]');
  assert.equal(saved.payload.body.api_key, '[REDACTED]');
  assert.equal(saved.payload.body.messages[0].content, 'search Taiwan news');
  assert.equal(saved.payload.body.tools[0].name, 'WebSearch');
  assert.equal((await fs.stat(result.file_path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(result.file_path))).mode & 0o777, 0o700);

  const index = await fs.readFile(path.join(path.dirname(result.file_path), 'index.jsonl'), 'utf8');
  assert.match(index, /"event":"client_request"/);
  assert.doesNotMatch(index, /super-secret|session=abc/);
});

test('V0.2.28.20 diagnostic trace omits raw Base64 and records bounded media metadata', async (t) => {
  const rootDir = await tempDir(t);
  const store = new WebToolDiagnosticTraceStore({ rootDir, sessionId: 'media-trace' });
  const raw = 'QUJD'.repeat(1024 * 256);
  const result = await store.write({
    request_id: 'req-media', event: 'client_request', direction: 'claude_code_to_proxy',
    payload: { body: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: raw } }] }] } },
  });
  const saved = JSON.parse(await fs.readFile(result.file_path, 'utf8'));
  const source = saved.payload.body.messages[0].content[0].source;
  assert.equal(source.data, '[OMITTED_BASE64]');
  assert.equal(source.base64_chars, raw.length);
  assert.equal(typeof source.estimated_decoded_bytes, 'number');
  assert.match(source.base64_sha256, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(result.file_path)).size < 100_000, true);
});
