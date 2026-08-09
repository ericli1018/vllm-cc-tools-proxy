import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../lib/http.js';
import { boundedText, detectMediaType } from '../lib/media.js';
import { runCommand } from '../lib/process.js';
import { normalizeImage, cropImage as defaultCropImage } from './image.js';
import { VisualAssetRegistry } from '../visual/asset-registry.js';
import { analyzeVisualAssets as defaultAnalyzeVisualAssets } from '../visual/vision-client.js';
import { batchVisualPages } from '../visual/pdf-batcher.js';
import { classifyPdfPage as defaultClassifyPdfPage } from '../visual/pdf-page-classifier.js';
import { buildPdfTiles } from '../visual/pdf-tiler.js';
import { mergePageEvidence } from '../visual/pdf-evidence-merger.js';

function parsePageSize(value) {
  const match = String(value || '').match(/([0-9.]+)\s*x\s*([0-9.]+)\s*pts/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

function parsePdfInfo(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) values[match[1].trim().toLowerCase().replaceAll(' ', '_')] = match[2].trim();
  }
  return {
    pages: Number.parseInt(values.pages || '0', 10),
    encrypted: /^yes/i.test(values.encrypted || ''),
    title: values.title || '',
    pageSize: parsePageSize(values.page_size),
  };
}

function parsePdfImagePages(text) {
  const pages = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+\d+\s+(image|smask|mask)\b/i);
    if (match) pages.add(Number(match[1]));
  }
  return pages;
}

function adaptiveDpi(pageSize, { targetLongEdge, minDpi, maxDpi, fallback }) {
  if (!pageSize) return fallback;
  const longEdgePoints = Math.max(pageSize.width, pageSize.height);
  const dpi = Math.round((targetLongEdge * 72) / longEdgePoints);
  return Math.max(minDpi, Math.min(maxDpi, dpi));
}

function overviewDpi(pageSize) {
  return adaptiveDpi(pageSize, { targetLongEdge: 3500, minDpi: 220, maxDpi: 320, fallback: 300 });
}

function classificationDpi(pageSize) {
  return adaptiveDpi(pageSize, { targetLongEdge: 1600, minDpi: 96, maxDpi: 160, fallback: 120 });
}

function schematicOverviewDpi(pageSize) {
  return adaptiveDpi(pageSize, { targetLongEdge: 4200, minDpi: 300, maxDpi: 400, fallback: 360 });
}

async function renderPage(inputPath, directory, page, limits, signal, runner, dpi, kind = 'overview') {
  const prefix = path.join(directory, `page-${page}-${kind}`);
  await runner('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', String(dpi), inputPath, prefix], {
    timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: 2 * 1024 * 1024,
  });
  return normalizeImage(await fs.readFile(`${prefix}.png`), { ...limits, signal, runner });
}

function cropDpi(pageWidthPoints, pageHeightPoints, rootBox, depth, overview) {
  const [, , right, bottom] = rootBox;
  const [left, top] = rootBox;
  const cropWidthPoints = pageWidthPoints * Math.max(1, right - left) / 1000;
  const cropHeightPoints = pageHeightPoints * Math.max(1, bottom - top) / 1000;
  const desired = Math.round((2400 * 72) / Math.max(cropWidthPoints, cropHeightPoints));
  const minDpi = Math.max(360, Number(overview) || 300);
  const maxDpi = depth <= 1 ? 600 : 720;
  return Math.max(minDpi, Math.min(maxDpi, desired));
}

function pdfRegionPixels(pageWidthPoints, pageHeightPoints, rootBox, dpi) {
  const [leftN, topN, rightN, bottomN] = rootBox;
  const pageWidthPx = (pageWidthPoints * dpi) / 72;
  const pageHeightPx = (pageHeightPoints * dpi) / 72;
  const left = Math.floor((leftN / 1000) * pageWidthPx);
  const top = Math.floor((topN / 1000) * pageHeightPx);
  const right = Math.ceil((rightN / 1000) * pageWidthPx);
  const bottom = Math.ceil((bottomN / 1000) * pageHeightPx);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

async function renderPdfRegion(asset, rootBox, dpi, limits, signal, runner, label = 'region') {
  const metadata = asset?.sourceMetadata || {};
  const page = Number(metadata.page);
  const pageWidthPoints = Number(metadata.pageWidthPoints);
  const pageHeightPoints = Number(metadata.pageHeightPoints);
  if (asset?.sourceKind !== 'pdf_page' || !metadata.pdfPath || !Number.isInteger(page)
    || !Number.isFinite(pageWidthPoints) || !Number.isFinite(pageHeightPoints)) {
    throw new HttpError(422, 'PDF region source metadata is unavailable.', { code: 'invalid_visual_region_source' });
  }
  const region = pdfRegionPixels(pageWidthPoints, pageHeightPoints, rootBox, dpi);
  const prefix = path.join(metadata.directory, `page-${page}-${label}-${rootBox.join('-')}`);
  await runner('pdftoppm', [
    '-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', String(dpi),
    '-x', String(region.left), '-y', String(region.top), '-W', String(region.width), '-H', String(region.height),
    metadata.pdfPath, prefix,
  ], { timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: 2 * 1024 * 1024 });
  return normalizeImage(await fs.readFile(`${prefix}.png`), { ...limits, signal, runner });
}

async function renderPdfCrop(asset, authorization, limits, signal, runner) {
  const metadata = asset?.sourceMetadata || {};
  const page = Number(metadata.page);
  const pageWidthPoints = Number(metadata.pageWidthPoints);
  const pageHeightPoints = Number(metadata.pageHeightPoints);
  if (asset?.sourceKind !== 'pdf_page' || !metadata.pdfPath || !Number.isInteger(page)
    || !Number.isFinite(pageWidthPoints) || !Number.isFinite(pageHeightPoints)) {
    throw new HttpError(422, 'PDF crop source metadata is unavailable.', { code: 'invalid_visual_crop_source' });
  }
  const dpi = cropDpi(pageWidthPoints, pageHeightPoints, authorization.rootBox, authorization.depth, metadata.overviewDpi);
  const region = pdfRegionPixels(pageWidthPoints, pageHeightPoints, authorization.rootBox, dpi);
  const [leftN, topN, rightN, bottomN] = authorization.rootBox;
  const prefix = path.join(metadata.directory, `page-${page}-crop-${authorization.sourceId}-${authorization.depth}-${leftN}-${topN}-${rightN}-${bottomN}`);
  await runner('pdftoppm', [
    '-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', String(dpi),
    '-x', String(region.left), '-y', String(region.top), '-W', String(region.width), '-H', String(region.height),
    metadata.pdfPath, prefix,
  ], { timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: 2 * 1024 * 1024 });
  const normalized = await normalizeImage(await fs.readFile(`${prefix}.png`), { ...limits, signal, runner });
  return { ...normalized, renderDpi: dpi };
}

function pageDimensions(info, normalized, dpi) {
  return {
    width: info.pageSize?.width || ((normalized.originalWidth || normalized.width) * 72) / dpi,
    height: info.pageSize?.height || ((normalized.originalHeight || normalized.height) * 72) / dpi,
  };
}

function visionCallOptions({
  vllmVisionUrl, vllmVisionModel, vllmVisionApiKey, vllmVisionProvider, vllmVisionThink,
  registry, signal, onProgress, cropImage, limits, runner,
}) {
  return {
    baseUrl: vllmVisionUrl,
    model: vllmVisionModel,
    apiKey: vllmVisionApiKey,
    provider: vllmVisionProvider,
    think: vllmVisionThink,
    registry,
    signal,
    onProgress,
    cropImage: (asset, authorization, callOptions) => asset?.sourceKind === 'pdf_page'
      ? renderPdfCrop(asset, authorization, { ...limits, ...callOptions }, callOptions?.signal || signal, runner)
      : cropImage(asset, authorization, { ...limits, ...callOptions, runner }),
  };
}

export async function parsePdf(buffer, options) {
  const {
    limits, onProgress = () => {}, signal, runner = runCommand,
    vllmVisionUrl = '', vllmVisionModel = '', vllmVisionApiKey = '',
    vllmVisionProvider = 'vllm', vllmVisionThink = false,
    analyzeVisualAssets = defaultAnalyzeVisualAssets, cropImage = defaultCropImage,
    classifyPage = defaultClassifyPdfPage,
  } = options;
  if (!Buffer.isBuffer(buffer) || detectMediaType(buffer) !== 'application/pdf') throw new HttpError(422, 'Input is not a valid PDF.', { code: 'invalid_pdf' });
  if (buffer.length > limits.maxDecodedBytes) throw new HttpError(413, 'PDF exceeds the configured byte limit.', { code: 'media_too_large' });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-cc-pdf-'));
  const inputPath = path.join(directory, 'input.pdf');
  try {
    await fs.writeFile(inputPath, buffer, { mode: 0o600 });
    const infoResult = await runner('pdfinfo', [inputPath], { timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: 2 * 1024 * 1024 });
    const info = parsePdfInfo(infoResult.stdout.toString('utf8'));
    if (info.encrypted) throw new HttpError(422, 'PDF is encrypted or requires a password.', { code: 'encrypted_pdf' });
    if (!Number.isInteger(info.pages) || info.pages < 1) throw new HttpError(422, 'PDF contains no readable pages.', { code: 'empty_pdf' });
    if (info.pages > limits.maxPdfPages) throw new HttpError(413, 'PDF exceeds the configured page limit.', { code: 'pdf_page_limit' });
    await onProgress(`已確認 ${info.pages} 頁；正在抽取原生文字…`, {
      phase: 'pdf_metadata', total: info.pages, received_pdf_pages: info.pages, processed_pdf_pages: 0,
    });

    const pages = [];
    let insufficientCount = 0;
    for (let page = 1; page <= info.pages; page += 1) {
      const textResult = await runner('pdftotext', ['-f', String(page), '-l', String(page), '-layout', '-nopgbrk', inputPath, '-'], {
        timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: Math.min(limits.maxOutputChars * 4, 16 * 1024 * 1024),
      });
      const nativeText = textResult.stdout.toString('utf8').replace(/\f/g, '').trim();
      const insufficient = nativeText.length < limits.nativeTextMinCharsPerPage;
      if (insufficient) insufficientCount += 1;
      pages.push({ page, nativeText, insufficient, route: 'TEXT', confidence: 1, reason: 'native text path' });
    }

    const visionEnabled = Boolean(vllmVisionUrl && vllmVisionModel);
    const warnings = [];
    if (insufficientCount === info.pages && !visionEnabled) {
      throw new HttpError(422, 'Visual vLLM endpoint is required for scanned or low-text PDF pages.', { code: 'vision_endpoint_required' });
    }
    if (insufficientCount > 0 && !visionEnabled) warnings.push(`low_text_pages_without_visual_analysis:${insufficientCount}`);

    let rasterImagePages = new Set();
    if (visionEnabled) {
      try {
        const imagesResult = await runner('pdfimages', ['-list', inputPath], {
          timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: 4 * 1024 * 1024,
        });
        rasterImagePages = parsePdfImagePages(imagesResult.stdout.toString('utf8'));
      } catch {
        warnings.push('pdf_image_inventory_unavailable');
      }
    }

    let classificationCount = 0;
    if (visionEnabled) {
      const dpi = classificationDpi(info.pageSize);
      await onProgress(`正在分類 ${info.pages} 頁 PDF 內容…`, { phase: 'pdf_classify', total: info.pages });
      for (const page of pages) {
        const normalized = await renderPage(inputPath, directory, page.page, limits, signal, runner, dpi, 'classify');
        const size = pageDimensions(info, normalized, dpi);
        const registry = new VisualAssetRegistry();
        const asset = registry.add({
          ...normalized,
          label: `PDF page ${page.page} classification overview`,
          sourceKind: 'pdf_page',
          sourceMetadata: {
            pdfPath: inputPath, directory, page: page.page,
            pageWidthPoints: size.width, pageHeightPoints: size.height, overviewDpi: dpi,
          },
        });
        let classification;
        try {
          classification = await classifyPage(asset, {
            analyzeVisualAssets,
            ...visionCallOptions({
              vllmVisionUrl, vllmVisionModel, vllmVisionApiKey, vllmVisionProvider, vllmVisionThink,
              registry, signal, onProgress, cropImage, limits, runner,
            }),
          });
        } catch (error) {
          classification = { route: 'DENSE_PAGE', confidence: 0, reason: `classification_failed:${error?.code || error?.name || 'error'}` };
        }
        const allowed = new Set(['TEXT', 'DIAGRAM', 'SCHEMATIC', 'DENSE_PAGE']);
        page.route = allowed.has(classification?.route) ? classification.route : 'DENSE_PAGE';
        page.confidence = Number.isFinite(Number(classification?.confidence)) ? Number(classification.confidence) : 0;
        page.reason = String(classification?.reason || '');
        page.rasterImage = rasterImagePages.has(page.page);
        if (page.route === 'TEXT' && page.rasterImage && page.confidence < 0.5) page.route = 'DENSE_PAGE';
        classificationCount += 1;
        await onProgress(`PDF 頁面分類 ${classificationCount}/${info.pages}…`, {
          phase: 'pdf_classify', completed: classificationCount, total: info.pages, page: page.page, route: page.route,
        });
      }
    }

    const visualBatches = [];
    let visualBatchCount = 0;
    let visualUsed = classificationCount > 0;
    const analysisRegistry = new VisualAssetRegistry();

    const genericEntries = new Map([['TEXT', []], ['DIAGRAM', []], ['DENSE_PAGE', []]]);
    const standardDpi = overviewDpi(info.pageSize);
    for (const page of pages) {
      if (!visionEnabled || page.route === 'SCHEMATIC' || (page.route === 'TEXT' && !page.insufficient)) continue;
      const normalized = await renderPage(inputPath, directory, page.page, limits, signal, runner, standardDpi, 'overview');
      const size = pageDimensions(info, normalized, standardDpi);
      const asset = analysisRegistry.add({
        ...normalized,
        label: `PDF page ${page.page} ${page.route}`,
        sourceKind: 'pdf_page',
        sourceMetadata: {
          pdfPath: inputPath, directory, page: page.page,
          pageWidthPoints: size.width, pageHeightPoints: size.height, overviewDpi: standardDpi,
        },
      });
      genericEntries.get(page.route)?.push({ ...page, asset });
    }

    for (const [route, entries] of genericEntries) {
      if (entries.length === 0) continue;
      const batches = batchVisualPages(entries, limits.maxVisualPagesPerBatch || 4);
      const prompt = route === 'TEXT'
        ? 'Transcribe the scanned or image-based PDF text faithfully. Preserve headings, lists, table-like alignment, code/spec tokens and uncertainty. Do not answer the final user task.'
        : route === 'DIAGRAM'
          ? 'Analyze these PDF diagrams as visual evidence. Preserve page/source identifiers, nodes, arrows, labels, direction, sequence and relationships. Request a precise crop only when necessary. Do not answer the final user task.'
          : 'Analyze these dense or mixed PDF pages conservatively. Extract visible text, tables, diagrams, labels and relationships. Preserve uncertainty and source identifiers. Request a precise crop only when necessary. Do not answer the final user task.';
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        await onProgress(`正在分析 ${route} 頁面 ${index + 1}/${batches.length}…`, { phase: 'pdf_visual_batch', route, batch: index + 1, batches: batches.length });
        const result = await analyzeVisualAssets(batch.map((entry) => entry.asset), {
          ...visionCallOptions({
            vllmVisionUrl, vllmVisionModel, vllmVisionApiKey, vllmVisionProvider, vllmVisionThink,
            registry: analysisRegistry, signal, onProgress, cropImage, limits, runner,
          }),
          prompt,
        });
        visualUsed = true;
        visualBatchCount += 1;
        visualBatches.push({ pages: batch.map((entry) => entry.page), route, markdown: result.markdown, cropCount: result.cropCount });
        warnings.push(...(result.warnings || []));
      }
    }

    for (const page of pages.filter((entry) => visionEnabled && entry.route === 'SCHEMATIC')) {
      const dpi = schematicOverviewDpi(info.pageSize);
      await onProgress(`正在準備第 ${page.page} 頁 schematic overview…`, { phase: 'pdf_schematic_overview', page: page.page });
      const normalized = await renderPage(inputPath, directory, page.page, limits, signal, runner, dpi, 'schematic-overview');
      const size = pageDimensions(info, normalized, dpi);
      const root = analysisRegistry.add({
        ...normalized,
        label: `PDF page ${page.page} schematic overview`,
        sourceKind: 'pdf_page',
        sourceMetadata: {
          pdfPath: inputPath, directory, page: page.page,
          pageWidthPoints: size.width, pageHeightPoints: size.height, overviewDpi: dpi,
        },
      });
      const commonOptions = visionCallOptions({
        vllmVisionUrl, vllmVisionModel, vllmVisionApiKey, vllmVisionProvider, vllmVisionThink,
        registry: analysisRegistry, signal, onProgress, cropImage, limits, runner,
      });
      const overviewResult = await analyzeVisualAssets([root], {
        ...commonOptions,
        prompt: `Analyze PDF page ${page.page} as a full-page electronic schematic overview. Identify functional blocks, major components, buses, power/clock/reset domains and visible cross-region relationships. Preserve source_id and uncertainty. Do not answer the final user task.`,
      });
      visualBatchCount += 1;
      visualUsed = true;
      warnings.push(...(overviewResult.warnings || []));

      const tiles = buildPdfTiles(size, { overlap: 0.15, targetLongEdgePx: 2300, dpi: 360, maxTiles: 12 });
      await onProgress(`第 ${page.page} 頁 schematic 將切成 ${tiles.length} 個 overlapping tiles…`, {
        phase: 'pdf_schematic_tile', page: page.page, count: tiles.length,
      });
      const tileEntries = [];
      for (const tile of tiles) {
        const image = await renderPdfRegion(root, tile.bbox, 360, limits, signal, runner, `tile-${tile.index}`);
        const asset = analysisRegistry.registerRegion(root.sourceId, image, {
          rootBox: tile.bbox,
          label: `PDF page ${page.page} schematic tile ${tile.index}/${tiles.length}`,
          regionKind: 'schematic_tile',
          sourceMetadata: { tileIndex: tile.index, tileCount: tiles.length, tileBbox: tile.bbox },
        });
        tileEntries.push({ page: page.page, tile, asset });
      }

      const regionEvidence = [];
      const tileBatches = batchVisualPages(tileEntries, limits.maxVisualPagesPerBatch || 4);
      for (let index = 0; index < tileBatches.length; index += 1) {
        const batch = tileBatches[index];
        const result = await analyzeVisualAssets(batch.map((entry) => entry.asset), {
          ...commonOptions,
          prompt: `Analyze schematic tiles for PDF page ${page.page}. Extract only observable components, reference designators, pins, net/signal labels, power rails, clocks, resets, bus connections and wire relationships. Preserve each source_id. Duplicate overlap is expected; do not invent continuity when labels are unreadable. Request a precise crop only for an essential small region. Do not answer the final user task.`,
        });
        visualBatchCount += 1;
        warnings.push(...(result.warnings || []));
        regionEvidence.push({
          sourceId: batch.map((entry) => entry.asset.sourceId).join(','),
          markdown: result.markdown,
        });
      }
      await onProgress(`正在合併第 ${page.page} 頁 schematic evidence…`, { phase: 'pdf_schematic_merge', page: page.page });
      const merged = mergePageEvidence({
        page: page.page,
        route: 'SCHEMATIC',
        nativeText: page.nativeText,
        overview: overviewResult.markdown,
        regions: regionEvidence,
      });
      visualBatches.push({
        pages: [page.page], route: 'SCHEMATIC', markdown: merged,
        cropCount: Number(overviewResult.cropCount || 0),
      });
    }

    const parts = [];
    for (const page of pages) {
      parts.push([
        `[VCC_PDF_PAGE_BEGIN index=${page.page} native_text_chars=${page.nativeText.length} route=${page.route}]`,
        page.nativeText,
        '[VCC_PDF_PAGE_END]',
      ].join('\n'));
    }
    for (const batch of visualBatches) {
      parts.push([
        `[VCC_PDF_VISUAL_BATCH_BEGIN pages=${batch.pages.join(',')} route=${batch.route || 'DENSE_PAGE'} crop_count=${batch.cropCount}]`,
        batch.markdown,
        '[VCC_PDF_VISUAL_BATCH_END]',
      ].join('\n'));
    }
    const bounded = boundedText(parts.join('\n\n'), limits.maxOutputChars);
    if (bounded.truncated) warnings.push('output_char_limit');
    await onProgress('PDF 內容已完成合併。', { phase: 'pdf_complete', completed: info.pages, total: info.pages });
    return {
      parser: visualUsed ? 'poppler+visual-vllm' : 'poppler',
      visual_used: visualUsed,
      page_count: info.pages,
      processed_pages: info.pages,
      visual_batch_count: visualBatchCount,
      classification_count: classificationCount,
      markdown: bounded.text,
      warnings: [...new Set(warnings)],
      truncated: bounded.truncated,
      original_chars: bounded.originalChars,
      returned_chars: bounded.text.length,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
