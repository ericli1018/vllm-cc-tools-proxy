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
  assert.match(result.markdown, /\[VCC_PDF_PAGE_BEGIN index=1/);
  assert.doesNotMatch(result.markdown, /<page|<native_text|<visual_batch/);
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
  assert.match(result.markdown, /\[VCC_PDF_VISUAL_BATCH_BEGIN pages=1/);
  assert.doesNotMatch(result.markdown, /<page|<native_text|<visual_batch/);
  assert.equal(result.visual_used, true);
});

test('parsePdf rejects scanned pages when visual endpoint is absent', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/scanned.pdf', import.meta.url));
  await assert.rejects(() => parsePdf(buffer, { limits, vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '' }), /Visual vLLM endpoint/);
});


test('parsePdf processes all 20 received pages in five visual batches', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const progress = [];
  const visualCalls = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 20\nEncrypted: no\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') {
      const page = Number(args[1]);
      return { stdout: Buffer.from(`page ${page} native text `.repeat(10)), stderr: Buffer.alloc(0) };
    }
    if (command === 'pdftoppm') {
      const prefix = args.at(-1);
      await fs.writeFile(`${prefix}.png`, png);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (command === 'identify') return { stdout: Buffer.from('600 180'), stderr: Buffer.alloc(0) };
    if (command === 'convert') {
      await fs.writeFile(args.at(-1), png);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision', vllmVisionProvider: 'vllm', vllmVisionThink: false,
    onProgress: async (message, details) => progress.push({ message, details }),
    analyzeVisualAssets: async (assets, options) => {
      visualCalls.push({ assets, options });
      return { markdown: `batch ${visualCalls.length}`, warnings: [], cropCount: 0 };
    },
  });
  assert.equal(result.page_count, 20);
  assert.equal(result.processed_pages, 20);
  assert.equal(result.visual_batch_count, 5);
  assert.deepEqual(visualCalls.map((call) => call.assets.length), [4,4,4,4,4]);
  assert.ok(progress.some((item) => item.message.includes('已接收 20 頁 PDF；將分成 5 批')));
  assert.equal(visualCalls.every((call) => call.options.provider === 'vllm' && call.options.think === false), true);
});
