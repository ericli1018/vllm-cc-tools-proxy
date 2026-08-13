import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parsePdf } from '../src/parsers/pdf.js';
import { HttpError } from '../src/lib/http.js';

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
    classifyPage: async () => ({ route: 'TEXT', confidence: 0.95, reason: 'scanned text' }),
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
    classifyPage: async () => ({ route: 'DENSE_PAGE', confidence: 0.8, reason: 'test dense page' }),
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
  assert.ok(progress.some((item) => item.details?.phase === 'pdf_classify' && item.details?.completed === 20));
  assert.ok(progress.some((item) => item.message.includes('正在分析 DENSE_PAGE 頁面 1/5')));
  assert.equal(visualCalls.every((call) => call.options.provider === 'vllm' && call.options.think === false), true);
});

test('V0.2.27 classifies every page at low DPI and analyzes only routed visual pages at overview DPI', async () => {
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
    classifyPage: async (asset) => {
      const page = asset.sourceMetadata.page;
      if (page === 1) return { route: 'TEXT', confidence: 0.99, reason: 'prose' };
      if (page === 2) return { route: 'DIAGRAM', confidence: 0.95, reason: 'embedded diagram' };
      return { route: 'TEXT', confidence: 0.95, reason: 'scanned text' };
    },
    analyzeVisualAssets: async (assets) => { visualCalls.push(assets); return { markdown: 'VISUAL', warnings: [], cropCount: 0 }; },
  });
  const classificationRenders = rendered.filter((entry) => entry.dpi <= 160);
  const evidenceRenders = rendered.filter((entry) => entry.dpi >= 220);
  assert.deepEqual(classificationRenders.map((entry) => entry.page), [1, 2, 3]);
  assert.deepEqual(evidenceRenders.map((entry) => entry.page), [2, 3]);
  assert.equal(evidenceRenders.every((entry) => entry.dpi >= 290 && entry.dpi <= 305), true);
  assert.equal(rendered.some((entry) => entry.dpi === 180), false);
  assert.equal(visualCalls.length, 2);
  assert.equal(result.visual_used, true);
  assert.equal(result.visual_batch_count, 2);
  assert.equal(result.classification_count, 3);
});

test('V0.2.27 text-only pages use low-cost classification but skip evidence Vision when routed TEXT', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  let visualCalls = 0;
  const renders = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 2\nEncrypted: no\nPage size: 612 x 792 pts\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('complete native text '.repeat(20)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from('page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { renders.push([...args]); await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('1200 1600'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    classifyPage: async () => ({ route: 'TEXT', confidence: 0.99, reason: 'plain text' }),
    analyzeVisualAssets: async () => { visualCalls += 1; return { markdown: 'unexpected', warnings: [], cropCount: 0 }; },
  });
  assert.equal(renders.length, 2);
  assert.equal(renders.every((args) => Number(args[args.indexOf('-r') + 1]) <= 160), true);
  assert.equal(visualCalls, 0);
  assert.equal(result.visual_used, true);
  assert.equal(result.visual_batch_count, 0);
  assert.equal(result.classification_count, 2);
});

test('V0.2.27 nested PDF crops re-render routed visual regions from the original PDF at higher bounded DPI', async () => {
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
    classifyPage: async () => ({ route: 'DIAGRAM', confidence: 0.9, reason: 'test diagram' }),
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
  assert.equal(renders.length, 4);
  assert.ok(renders[0].dpi <= 160);
  assert.ok(renders[1].dpi >= 290 && renders[1].dpi <= 305);
  assert.ok(renders[2].dpi > renders[1].dpi && renders[2].dpi <= 600);
  assert.ok(renders[3].dpi >= renders[2].dpi && renders[3].dpi <= 720);
  assert.match(renders[2].args.join(' '), /-x \d+ -y \d+ -W \d+ -H \d+/);
  assert.match(renders[3].args.join(' '), /-x \d+ -y \d+ -W \d+ -H \d+/);
});

test('V0.2.27 routes a text-rich vector-only page to schematic tiling', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const renders = [];
  const analysis = [];
  const progress = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('U15 RTL8211F ETH_CLK RESET_N GPIOZ3 '.repeat(15)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from('page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') {
      renders.push([...args]);
      await fs.writeFile(`${args.at(-1)}.png`, png);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    onProgress: async (message, details) => progress.push({ message, details }),
    classifyPage: async () => ({ route: 'SCHEMATIC', confidence: 0.99, reason: 'dense nets' }),
    analyzeVisualAssets: async (assets, options) => {
      analysis.push({ assets, options });
      return { markdown: assets[0]?.regionKind === 'schematic_tile' ? 'R109 connects ETH_CLK' : 'Overview Ethernet schematic', warnings: [], cropCount: 0 };
    },
  });
  assert.ok(renders.some((args) => args.includes('-x')), 'schematic tiles must use original-PDF region rendering');
  assert.ok(analysis.length >= 2, 'schematic must analyze overview and tile regions');
  assert.match(result.markdown, /Page 1 — SCHEMATIC/);
  assert.match(result.markdown, /R109 connects ETH_CLK/);
  const tileRenders = progress.filter((item) => item.details?.phase === 'pdf_schematic_tile_render');
  const tileBatches = progress.filter((item) => item.details?.phase === 'pdf_schematic_tile_analyze');
  assert.ok(tileRenders.length >= 2);
  assert.equal(tileRenders.at(-1).details.completed, tileRenders.at(-1).details.total);
  assert.ok(tileBatches.length >= 1);
  assert.equal(tileBatches.at(-1).details.completed, tileBatches.at(-1).details.total);
});

test('V0.2.28.4 isolates every schematic tile into one sequential Vision request', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const calls = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('U15 R109 ETH_CLK RESET_N GPIOZ3 '.repeat(15)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from(''), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    classifyPage: async () => ({ route: 'SCHEMATIC', confidence: 0.99, reason: 'electronic schematic with reference designators and nets' }),
    analyzeVisualAssets: async (assets, options) => {
      calls.push({ assets, options });
      return { markdown: assets[0].regionKind === 'schematic_tile' ? `Tile evidence ${assets[0].sourceId}` : 'Overview schematic', warnings: [], cropCount: 0 };
    },
  });
  const tileCalls = calls.filter((entry) => entry.assets[0]?.regionKind === 'schematic_tile');
  assert.ok(tileCalls.length >= 2);
  assert.equal(tileCalls.every((entry) => entry.assets.length === 1), true);
  assert.equal(tileCalls.every((entry) => entry.assets[0].sourceMetadata?.overlap === 0.20), true);
  assert.ok(tileCalls.every((entry) => entry.options.recoveryContext === 'zoom_tile'));
  assert.ok(tileCalls.every((entry) => entry.options.timeoutMs === 30000));
});

test('V0.2.28.4 contains an expected schematic tile Vision failure and continues later tiles', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  let tileCall = 0;
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('U15 R109 ETH_CLK RESET_N GPIOZ3 '.repeat(15)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from(''), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    classifyPage: async () => ({ route: 'SCHEMATIC', confidence: 0.99, reason: 'electronic schematic with reference designators and nets' }),
    analyzeVisualAssets: async (assets) => {
      if (assets[0]?.regionKind !== 'schematic_tile') return { markdown: 'Overview schematic', warnings: [], cropCount: 0 };
      tileCall += 1;
      if (tileCall === 2) throw new HttpError(502, 'Vision headers timeout.', { code: 'vision_service_error', retryable: true, details: { transport_code: 'UND_ERR_HEADERS_TIMEOUT' } });
      return { markdown: `Observed tile ${tileCall}: R109 connects ETH_CLK.`, warnings: [], cropCount: 0 };
    },
  });
  assert.ok(tileCall >= 3, 'later tiles must continue after one upstream tile failure');
  assert.match(result.markdown, /Observed tile 1/);
  assert.match(result.markdown, /Observed tile 3/);
  assert.match(result.markdown, /evidence unavailable.*vision_service_error/i);
  assert.ok(result.warnings.includes('schematic_tile_vision_service_error'));
});

test('V0.2.28.4 does not hide programming errors from schematic tile analysis', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('U15 R109 ETH_CLK RESET_N GPIOZ3 '.repeat(15)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from(''), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  await assert.rejects(() => parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    classifyPage: async () => ({ route: 'SCHEMATIC', confidence: 0.99, reason: 'electronic schematic with reference designators and nets' }),
    analyzeVisualAssets: async (assets) => {
      if (assets[0]?.regionKind !== 'schematic_tile') return { markdown: 'Overview schematic', warnings: [], cropCount: 0 };
      throw new Error('programming-bug');
    },
  }), /programming-bug/);
});

test('V0.2.27 scanned text routes through Vision transcription without schematic tiling', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const renders = [];
  const calls = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from(''), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from('   1     0 image 800 600 rgb 3 8 jpeg no 10 0 150 150 20K 1.0%\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { renders.push([...args]); await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    classifyPage: async () => ({ route: 'TEXT', confidence: 0.95, reason: 'scanned prose' }),
    analyzeVisualAssets: async (assets, options) => { calls.push({ assets, options }); return { markdown: 'SCANNED SPEC TEXT', warnings: [], cropCount: 0 }; },
  });
  assert.equal(renders.some((args) => args.includes('-x')), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.prompt, /transcrib|text/i);
  assert.match(result.markdown, /SCANNED SPEC TEXT/);
});

test('V0.2.27 diagram route uses overview Vision without deterministic schematic tiles', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const renders = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('Boot flow DDR_READY '.repeat(10)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from(''), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { renders.push([...args]); await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    classifyPage: async () => ({ route: 'DIAGRAM', confidence: 0.9, reason: 'flow chart' }),
    analyzeVisualAssets: async () => ({ markdown: 'START -> INIT -> READY', warnings: [], cropCount: 0 }),
  });
  assert.equal(renders.some((args) => args.includes('-x')), false);
  assert.match(result.markdown, /START -> INIT -> READY/);
});

test('V0.2.27.2 focused scope processes only requested page from a full PDF and permits a larger source document', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const extracted = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 100\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') {
      extracted.push(Number(args[1]));
      return { stdout: Buffer.from('Focused native text '.repeat(10)), stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, pageScope: { pages: [42], canonical: '42' },
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
  });
  assert.deepEqual(extracted, [42]);
  assert.equal(result.page_count, 100);
  assert.equal(result.processed_pages, 1);
  assert.deepEqual(result.requested_pages, [42]);
  assert.match(result.markdown, /VCC_PDF_PAGE_BEGIN index=42/);
});

test('V0.2.27.2 maps a Claude Code subset PDF back to the requested logical page number', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const extracted = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') {
      extracted.push(Number(args[1]));
      return { stdout: Buffer.from('Subset page native text '.repeat(10)), stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, pageScope: { pages: [42], canonical: '42' },
    vllmVisionUrl: '', vllmVisionModel: '', vllmVisionApiKey: '',
  });
  assert.deepEqual(extracted, [1]);
  assert.equal(result.page_count, 1);
  assert.equal(result.processed_pages, 1);
  assert.deepEqual(result.requested_pages, [42]);
  assert.match(result.markdown, /VCC_PDF_PAGE_BEGIN index=42/);
});

test('V0.2.27.2 rejects a focused scope that the received PDF cannot represent', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const runner = async (command) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 10\nEncrypted: no\n'), stderr: Buffer.alloc(0) };
    throw new Error(`unexpected command ${command}`);
  };
  await assert.rejects(
    () => parsePdf(buffer, { limits, runner, pageScope: { pages: [42, 43], canonical: '42-43' }, vllmVisionUrl: '', vllmVisionModel: '' }),
    (error) => error?.code === 'pdf_page_scope_unavailable',
  );
});

test('V0.29.0 unscoped large PDF returns a bounded document map without Vision or whole-document extraction', async () => {
  const calls = [];
  const fakeRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'pdfinfo') return { stdout: Buffer.from('Title: Large Manual\nPages: 50\nEncrypted: no\nPage size: 595 x 842 pts\n') };
    if (command === 'pdftotext') {
      const page = Number(args[args.indexOf('-f') + 1]);
      const text = page <= 4
        ? `Section ${page} Overview\nTopic for page ${page}\n`
        : `Chapter ${Math.ceil(page / 10)} Details\nPage ${page} material\n`;
      return { stdout: Buffer.from(text) };
    }
    throw new Error(`unexpected command in document-map path: ${command}`);
  };
  const result = await parsePdf(Buffer.from('%PDF-1.7\nlarge'), {
    limits: { ...limits, maxPdfPages: 20, maxOutputChars: 100000 },
    runner: fakeRunner,
    documentMapPageThreshold: 20,
    vllmVisionUrl: '', vllmVisionModel: '',
  });
  assert.equal(result.document_mode, 'map');
  assert.equal(result.page_count, 50);
  assert.ok(result.processed_pages > 0 && result.processed_pages <= 24);
  assert.equal(result.visual_used, false);
  assert.match(result.markdown, /Document Map/);
  assert.match(result.markdown, /Read\.pages/);
  assert.match(result.markdown, /p\.1:/);
  assert.match(result.markdown, /p\.50:/);
  assert.equal(calls.some((entry) => ['pdftoppm', 'pdfimages'].includes(entry.command)), false);
  assert.equal(calls.filter((entry) => entry.command === 'pdftotext').length, result.processed_pages);
});

test('V0.29.0 unscoped large scanned PDF can return a map without a configured Vision endpoint', async () => {
  const fakeRunner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 200\nEncrypted: no\nPage size: 595 x 842 pts\n') };
    if (command === 'pdftotext') return { stdout: Buffer.from('') };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const result = await parsePdf(Buffer.from('%PDF-1.7\nscan'), {
    limits: { ...limits, maxPdfPages: 20, maxOutputChars: 100000 },
    runner: fakeRunner,
    documentMapPageThreshold: 20,
    vllmVisionUrl: '', vllmVisionModel: '',
  });
  assert.equal(result.document_mode, 'map');
  assert.equal(result.page_count, 200);
  assert.match(result.markdown, /no native text detected/i);
  assert.match(result.warnings.join(','), /document_map_low_text/);
});

test('V0.29.3 DIAGRAM NEEDS_ZOOM falls back to sequential overlapping PDF tiles and merges evidence', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const calls = [];
  const renders = [];
  const progress = [];
  const runner = async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from('Pages: 1\nEncrypted: no\nPage size: 595 x 842 pts (A4)\n'), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from('Dense block diagram '.repeat(20)), stderr: Buffer.alloc(0) };
    if (command === 'pdfimages') return { stdout: Buffer.from(''), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { renders.push([...args]); await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('2480 3508'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    throw new Error(`unexpected command ${command}`);
  };
  const result = await parsePdf(buffer, {
    limits, runner, vllmVisionUrl: 'http://vision', vllmVisionModel: 'vision',
    onProgress: async (message, details) => progress.push({ message, details }),
    classifyPage: async () => ({ route: 'DIAGRAM', confidence: 0.9, reason: 'dense block diagram' }),
    analyzeVisualAssets: async (assets, options) => {
      calls.push({ assets, options });
      if (!assets[0]?.regionKind) {
        assert.equal(options.allowNeedsZoomFallback, true);
        return { markdown: 'VISUAL_STATUS: NEEDS_ZOOM\nVISUAL_REASON: labels are too dense at whole-page scale', warnings: [], cropCount: 0, needsZoom: true, visualStatus: 'needs_zoom' };
      }
      return { markdown: `VISUAL_STATUS: CONTENT\nVISUAL_DETAIL: SUFFICIENT\nVISUAL_EVIDENCE:\n- ${assets[0].sourceId} preserves local arrows and labels.`, warnings: [], cropCount: 0 };
    },
  });
  const tileCalls = calls.filter((entry) => entry.assets[0]?.regionKind === 'zoom_tile');
  assert.ok(tileCalls.length >= 2 && tileCalls.length <= 12);
  assert.ok(tileCalls.every((entry) => entry.options.recoveryContext === 'zoom_tile'), 'PDF zoom tiles must use the shared already-zoomed recovery policy');
  assert.ok(tileCalls.every((entry) => entry.options.timeoutMs === 30000), 'PDF zoom tiles must use the bounded 30 second child timeout');
  assert.ok(renders.some((args) => args.includes('-x')), 'fallback tiles must render PDF regions from the original page');
  const boxes = tileCalls.map((entry) => entry.assets[0].rootBox);
  const hasOverlap = boxes.some((a, i) => boxes.some((b, j) => i !== j
    && a[1] === b[1] && a[0] < b[0] && a[2] > b[0]));
  assert.equal(hasOverlap, true);
  assert.match(result.markdown, /Region evidence/);
  assert.match(result.markdown, /preserves local arrows and labels/);
  assert.equal(progress.some((item) => item.details?.phase === 'pdf_zoom_tile_analyze'), true);
});
