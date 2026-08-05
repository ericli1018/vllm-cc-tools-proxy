import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { prepareMediaHandles } from '../src/proxy/media-preflight.js';
import { createMediaAdapters } from '../src/proxy/media-adapters.js';

function imageMessage(base64) {
  return [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
  ] }] }];
}

test('media preflight replaces nested Base64 with request-scoped file handles', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const prepared = await prepareMediaHandles(imageMessage(png.toString('base64')), { maxDecodedBytes: 5_000_000 });
  const source = prepared.messages[0].content[0].content[0].source;
  assert.equal(source.type, 'proxy_file');
  assert.equal(source.media_type, 'image/png');
  assert.equal(typeof source.path, 'string');
  assert.equal('data' in source, false);
  assert.equal(prepared.allowedPaths.has(source.path), true);
  assert.deepEqual(await fs.readFile(source.path), png);
  await prepared.cleanup();
  await assert.rejects(fs.stat(prepared.root), /ENOENT/);
});

test('media adapter reads only handles created by the current preflight', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const prepared = await prepareMediaHandles(imageMessage(png.toString('base64')), { maxDecodedBytes: 5_000_000 });
  const block = prepared.messages[0].content[0].content[0];
  const adapters = createMediaAdapters({
    limits: { maxDecodedBytes: 5_000_000, maxOutputChars: 1000, maxImagePixels: 5_000_000, processTimeoutMs: 10000 },
    vllmVisionUrl: 'http://vision:8000', vllmVisionModel: 'vision', vllmVisionApiKey: '',
  }, undefined, undefined, {
    allowedMediaPaths: prepared.allowedPaths,
    normalizeImage: async (buffer) => { assert.deepEqual(buffer, png); return { buffer, mediaType: 'image/png', width: 600, height: 180 }; },
    analyzeVisualAssets: async () => ({ markdown: 'handled', warnings: [], cropCount: 0 }),
  });
  assert.match((await adapters.adaptImage(block)).text, /handled/);
  await assert.rejects(
    adapters.adaptImage({ type: 'image', source: { type: 'proxy_file', media_type: 'image/png', path: '/etc/passwd' } }),
    (error) => error.code === 'invalid_media_handle',
  );
  await prepared.cleanup();
});

test('vision admission wraps visual analysis and always releases', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  let active = 0;
  let peak = 0;
  let releases = 0;
  const adapters = createMediaAdapters({
    limits: { maxDecodedBytes: 5_000_000, maxOutputChars: 1000, maxImagePixels: 5_000_000, processTimeoutMs: 10000 },
    vllmVisionUrl: 'http://vision:8000', vllmVisionModel: 'vision', vllmVisionApiKey: '',
  }, undefined, undefined, {
    normalizeImage: async () => ({ buffer: png, mediaType: 'image/png', width: 600, height: 180 }),
    acquireVision: async () => { active += 1; peak = Math.max(peak, active); return () => { active -= 1; releases += 1; }; },
    analyzeVisualAssets: async () => ({ markdown: 'ok', warnings: [], cropCount: 0 }),
  });
  await adapters.adaptImage({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  assert.equal(peak, 1);
  assert.equal(active, 0);
  assert.equal(releases, 1);
});
