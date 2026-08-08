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
      return { stdout: Buffer.from(`page ${page}`), stderr: Buffer.alloc(0) };
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
  assert.ok(progress.some((item) => item.message.includes('已接收 20 頁 PDF；其中 20 頁將分成 5 批')));
  assert.equal(visualCalls.every((call) => call.options.provider === 'vllm' && call.options.think === false), true);
});

test('V0.2.26 selects only low-text or raster-image PDF pages and renders adaptive overview near 300 DPI', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const rendered = [];
  const visualCalls = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 3\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') {
      const page = Number(args[1]);
      return { stdout: Buffer.from(page === 3 ? 'tiny' : `page ${page} native text `.repeat(12)), stderr: Buffer.alloc(0) };
    }
    if (command === 'pdfimages') {
      return { stdout: Buffer.from('page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n--------------------------------------------------------------------------------------------\n   2     0 image     800   600  rgb     3   8  jpeg   no        10  0   150   150  20K 1.0%\n'), stderr: Buffer.alloc(0) };
    }
    if (command === 'pdftoppm') {
      const page = Number(args[1]);
      const dpi = Number(args[args.indexOf('-r') + 1]);
      rendered.push({ page, dpi, args: [...args] });
      await fs.writeFile(`${args.at(-1)}.png`, png);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') {
      await fs.writeFile(args.at(-1), png);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    analyzeVisualAssets: async (assets) => { visualCalls.push(assets); return { markdown: 'VISUAL', warnings: [], cropCount: 0 }; },
  });
  assert.deepEqual(rendered.map((entry) => entry.page), [2, 3]);
  assert.equal(rendered.every((entry) => entry.dpi >= 290 && entry.dpi <= 305), true);
  assert.equal(rendered.some((entry) => entry.dpi === 180), false);
  assert.equal(visualCalls.length, 1);
  assert.equal(visualCalls[0].length, 2);
  assert.equal(result.visual_used, true);
  assert.equal(result.visual_batch_count, 1);
});

test('V0.2.26 does not visually analyze text-only PDF pages merely because Vision is configured', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  let visualCalls = 0;
  let renders = 0;
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 2\nEncrypted: no\nPage size: 612 x 792 pts\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('complete native text '.repeat(20)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from('page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { renders += 1; throw new Error('text-only page must not render'); }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    analyzeVisualAssets: async () => { visualCalls += 1; return { markdown: 'unexpected', warnings: [], cropCount: 0 }; },
  });
  assert.equal(renders, 0);
  assert.equal(visualCalls, 0);
  assert.equal(result.visual_used, false);
  assert.equal(result.visual_batch_count, 0);
});

test('V0.2.26 nested PDF crops re-render the authorized root region from the original PDF at higher bounded DPI', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const renders = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('tiny'), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from('page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') {
      const dpi = Number(args[args.indexOf('-r') + 1]);
      renders.push({ dpi, args: [...args] });
      await fs.writeFile(`${args.at(-1)}.png`, png);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    analyzeVisualAssets: async (assets, options) => {
      const root = assets[0];
      const firstAuth = options.registry.authorizeCrop(root.sourceId, [100,100,900,900], 1);
      const firstCrop = await options.cropImage(root, firstAuth, {});
      const first = options.registry.registerCrop(root.sourceId, firstCrop, firstAuth, { purpose: 'first' });
      const secondAuth = options.registry.authorizeCrop(first.sourceId, [250,250,750,750], 2);
      const secondCrop = await options.cropImage(first, secondAuth, {});
      options.registry.registerCrop(first.sourceId, secondCrop, secondAuth, { purpose: 'second' });
      return { markdown: 'nested pdf crop ok', warnings: [], cropCount: 2 };
    },
  });
  assert.equal(renders.length, 3);
  assert.ok(renders[0].dpi >= 290 && renders[0].dpi <= 305);
  assert.ok(renders[1].dpi > renders[0].dpi && renders[1].dpi <= 600);
  assert.ok(renders[2].dpi >= renders[1].dpi && renders[2].dpi <= 720);
  assert.match(renders[1].args.join(' '), /-x \d+ -y \d+ -W \d+ -H \d+/);
  assert.match(renders[2].args.join(' '), /-x \d+ -y \d+ -W \d+ -H \d+/);
});
