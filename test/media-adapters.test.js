import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { decodeBase64Media, detectMediaType } from '../src/lib/media.js';
import { createMediaAdapters } from '../src/proxy/media-adapters.js';
import { MediaAnalysisRegistry } from '../src/media/analysis-registry.js';

test('decodeBase64Media strictly validates size and PDF magic', () => {
  const pdf = Buffer.from('%PDF-1.7\n');
  const decoded = decodeBase64Media(pdf.toString('base64'), 1024, 'application/pdf');
  assert.deepEqual(decoded, pdf);
  assert.equal(detectMediaType(decoded), 'application/pdf');
  assert.throws(() => decodeBase64Media('not*base64', 1024, 'application/pdf'), /Base64/);
});

test('document adapter uses local parser result and removes raw Base64', async () => {
  const pdf = Buffer.from('%PDF-1.7\nbody');
  const adapters = createMediaAdapters({
    limits: { maxDecodedBytes: 1024, maxOutputChars: 1000 },
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
  }, undefined, undefined, {
    parsePdf: async (buffer) => { assert.deepEqual(buffer, pdf); return { parser: 'poppler', page_count: 1, processed_pages: 1, visual_used: false, markdown: '# Parsed', warnings: [], truncated: false }; },
  });
  const base64 = pdf.toString('base64');
  const output = await adapters.adaptDocument({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } });
  assert.match(output.text, /# Parsed/);
  assert.equal(output.text.includes(base64), false);
});

test('image adapter sends normalized image to visual vLLM and removes Base64', async () => {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const adapters = createMediaAdapters({
    limits: { maxDecodedBytes: 5_000_000, maxOutputChars: 1000, maxImagePixels: 5_000_000, processTimeoutMs: 10000 },
    vllmVisionUrl: 'http://vision:8000', vllmVisionModel: 'vision', vllmVisionApiKey: 'key',
  }, undefined, undefined, {
    normalizeImage: async () => ({ buffer: png, mediaType: 'image/png', width: 600, height: 180 }),
    analyzeVisualAssets: async (assets) => { assert.equal(assets[0].sourceId, 'asset-1'); return { markdown: 'VISIBLE TEXT', warnings: [], cropCount: 0 }; },
  });
  const base64 = png.toString('base64');
  const output = await adapters.adaptImage({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
  assert.match(output.text, /VISIBLE TEXT/);
  assert.equal(output.text.includes(base64), false);
});

test('document adapter returns cached normalized block without reading or parsing media', async () => {
  let parses = 0;
  const cachedBlock = { type: 'text', text: '<document>cached</document>' };
  const adapters = createMediaAdapters({
    limits: { maxDecodedBytes: 1024, maxOutputChars: 1000 },
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
  }, undefined, () => assert.fail('cache hit must not emit progress'), {
    mediaCache: { get: async (key) => key === 'a'.repeat(64) ? { block: cachedBlock } : null, set: async () => true },
    parsePdf: async () => { parses += 1; throw new Error('must not parse'); },
  });
  const output = await adapters.adaptDocument({
    type: 'document', source: { type: 'proxy_file', media_type: 'application/pdf', path: '/missing', cache_key: 'a'.repeat(64) },
  });
  assert.deepEqual(output, cachedBlock);
  assert.equal(parses, 0);
});

test('concurrent identical document misses share one parser analysis and cache result', async () => {
  const pdf = Buffer.from('%PDF-1.7\nbody');
  const registry = new MediaAnalysisRegistry();
  const values = new Map();
  let parses = 0;
  const mediaCache = {
    get: async (key) => values.get(key) || null,
    set: async (key, value) => { values.set(key, value); return true; },
  };
  const adapters = createMediaAdapters({
    limits: { maxDecodedBytes: 1024, maxOutputChars: 1000 },
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
  }, undefined, undefined, {
    mediaCache,
    analysisRegistry: registry,
    parsePdf: async () => {
      parses += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { parser: 'poppler', page_count: 1, processed_pages: 1, visual_used: false, markdown: '# Parsed', warnings: [], truncated: false };
    },
  });
  const block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64'), cache_key: 'b'.repeat(64) } };
  const [first, second] = await Promise.all([adapters.adaptDocument(structuredClone(block)), adapters.adaptDocument(structuredClone(block))]);
  assert.equal(parses, 1);
  assert.deepEqual(first, second);
  assert.deepEqual((await mediaCache.get('b'.repeat(64))).block, first);
});

test('cache write failure does not discard the current document analysis result', async () => {
  const pdf = Buffer.from('%PDF-1.7\nbody');
  const adapters = createMediaAdapters({
    limits: { maxDecodedBytes: 1024, maxOutputChars: 1000 },
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
  }, undefined, undefined, {
    mediaCache: { get: async () => null, set: async () => false },
    analysisRegistry: new MediaAnalysisRegistry(),
    parsePdf: async () => ({ parser: 'poppler', page_count: 1, processed_pages: 1, visual_used: false, markdown: '# Available now', warnings: [], truncated: false }),
  });
  const output = await adapters.adaptDocument({
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64'), cache_key: '4'.repeat(64) },
  });
  assert.match(output.text, /Available now/);
});
