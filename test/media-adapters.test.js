import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { decodeBase64Media, detectMediaType } from '../src/lib/media.js';
import { createMediaAdapters } from '../src/proxy/media-adapters.js';

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
