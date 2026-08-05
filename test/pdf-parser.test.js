import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parsePdf } from '../src/parsers/pdf.js';

const limits = { maxDecodedBytes: 10 * 1024 * 1024, maxPdfPages: 20, maxOutputChars: 100000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20_000_000, maxVisualPagesPerBatch: 4 };

test('parsePdf uses native Poppler text without requiring vision', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const result = await parsePdf(buffer, { limits, vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '' });
  assert.equal(result.page_count, 1);
  assert.equal(result.visual_used, false);
  assert.match(result.markdown, /Native PDF text page/);
});

test('parsePdf sends scanned pages to visual analysis', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/scanned.pdf', import.meta.url));
  const calls = [];
  const result = await parsePdf(buffer, {
    limits, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision', vllmVisionApiKey: '',
    analyzeVisualAssets: async (assets) => { calls.push(assets); return { markdown: 'SCAN OCR CONTENT', warnings: [], cropCount: 0 }; },
  });
  assert.equal(calls.length, 1);
  assert.match(result.markdown, /SCAN OCR CONTENT/);
  assert.equal(result.visual_used, true);
});

test('parsePdf rejects scanned pages when visual endpoint is absent', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/scanned.pdf', import.meta.url));
  await assert.rejects(() => parsePdf(buffer, { limits, vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '' }), /Visual vLLM endpoint/);
});
