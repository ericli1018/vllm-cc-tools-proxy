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
  assert.match(source.cache_key, /^[a-f0-9]{64}$/);
  assert.match(source.media_sha256, /^[a-f0-9]{64}$/);
  assert.equal('data' in source, false);
  assert.equal(prepared.allowedPaths.has(source.path), true);
  assert.deepEqual(await fs.readFile(source.path), png);
  await prepared.cleanup();
  await assert.rejects(fs.stat(prepared.root), /ENOENT/);
});

test('media preflight deduplicates identical media within one request', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  const messages = [{ role: 'user', content: [structuredClone(block), structuredClone(block)] }];
  const prepared = await prepareMediaHandles(messages, { maxDecodedBytes: 5_000_000 }, {
    cacheKeyContext: { pipelineVersion: 'media-v3', visualPromptVersion: 'visual-v2', visionModel: 'vision', resourceProfile: 'default' },
  });
  const [first, second] = prepared.messages[0].content.map((item) => item.source);
  assert.equal(first.cache_key, second.cache_key);
  assert.equal(first.path, second.path);
  assert.equal(prepared.mediaEntries.length, 1);
  await prepared.cleanup();
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


test('media cache fingerprints change across visual provider and thinking modes', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const make = async (visionProvider, visionApiProtocol, visionThink) => prepareMediaHandles(
    imageMessage(png.toString('base64')),
    { maxDecodedBytes: 5_000_000 },
    { cacheKeyContext: {
      pipelineVersion: 'media-v4', visualPromptVersion: 'visual-v3', visionModel: 'qwen3.6:27b',
      visionProvider, visionApiProtocol, visionThink, resourceProfile: 'default',
    } },
  );
  const vllm = await make('vllm', 'openai-chat', false);
  const ollama = await make('ollama', 'ollama-native', false);
  const ollamaThink = await make('ollama', 'ollama-native', true);
  try {
    const key = (prepared) => prepared.mediaEntries[0].key;
    assert.notEqual(key(vllm), key(ollama));
    assert.notEqual(key(ollama), key(ollamaThink));
  } finally {
    await Promise.all([vllm.cleanup(), ollama.cleanup(), ollamaThink.cleanup()]);
  }
});

test('media preflight records every media occurrence path while deduplicating files', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } };
  const messages = [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [structuredClone(block)] },
    structuredClone(block),
  ] }];
  const prepared = await prepareMediaHandles(messages, { maxDecodedBytes: 5_000_000 });
  try {
    assert.equal(prepared.mediaEntries.length, 1);
    assert.deepEqual(prepared.mediaOccurrences.map((entry) => entry.path), [
      ['messages', 0, 'content', 0, 'content', 0],
      ['messages', 0, 'content', 1],
    ]);
    assert.equal(prepared.mediaOccurrences[0].key, prepared.mediaEntries[0].key);
    assert.equal(prepared.mediaOccurrences[1].key, prepared.mediaEntries[0].key);
  } finally {
    await prepared.cleanup();
  }
});
