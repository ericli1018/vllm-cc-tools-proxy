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


function documentMapSamplePages(pageCount, maxSamples = 24) {
  const total = Math.max(1, Number(pageCount) || 1);
  const limit = Math.max(1, Math.min(maxSamples, total));
  const selected = new Set();
  for (let page = 1; page <= Math.min(8, total, limit); page += 1) selected.add(page);
  if (selected.size < limit) selected.add(total);
  if (selected.size < limit && total > 1) selected.add(Math.max(1, total - 1));
  if (selected.size < limit) {
    const slots = limit - selected.size;
    for (let index = 1; index <= slots * 2 && selected.size < limit; index += 1) {
      const page = Math.max(1, Math.min(total, Math.round(1 + ((total - 1) * index) / (slots * 2 + 1))));
      selected.add(page);
    }
  }
  for (let page = 1; selected.size < limit && page <= total; page += 1) selected.add(page);
  return [...selected].sort((a, b) => a - b);
}

function documentMapHeading(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 3 && line.length <= 180 && !/^[-–—_\d\s.]+$/.test(line));
  if (lines.length === 0) return '(no native text detected; use Read.pages for this page)';
  return lines.slice(0, 2).join(' — ').slice(0, 260);
}

function documentMapTocEntries(samples) {
  const entries = [];
  const seen = new Set();
  for (const sample of samples.filter((entry) => entry.page <= 12)) {
    for (const raw of String(sample.text || '').split(/\r?\n/)) {
      const line = raw.replace(/\s+/g, ' ').trim();
      const match = line.match(/^(.{3,140}?)(?:\s+\.{2,}\s*|\s{2,})(\d{1,6})$/);
      if (!match) continue;
      const label = match[1].trim();
      const page = Number(match[2]);
      if (!label || !Number.isInteger(page) || page < 1) continue;
      const key = `${label.toLowerCase()}|${page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ label, page });
      if (entries.length >= 40) return entries;
    }
  }
  return entries;
}

async function buildPdfDocumentMap(inputPath, info, { limits, signal, runner, onProgress }) {
  const sampledPages = documentMapSamplePages(info.pages, 24);
  const samples = [];
  let nativeTextPages = 0;
  for (let index = 0; index < sampledPages.length; index += 1) {
    const page = sampledPages[index];
    const textResult = await runner('pdftotext', ['-f', String(page), '-l', String(page), '-layout', '-nopgbrk', inputPath, '-'], {
      timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: Math.min(256 * 1024, limits.maxOutputChars * 2),
    });
    const text = textResult.stdout.toString('utf8').replace(/\f/g, '').trim();
    if (text.length >= limits.nativeTextMinCharsPerPage) nativeTextPages += 1;
    samples.push({ page, text, heading: documentMapHeading(text) });
    await onProgress(`正在建立 PDF 文件地圖 ${index + 1}/${sampledPages.length}…`, {
      phase: 'pdf_document_map', completed: index + 1, total: sampledPages.length,
      received_pdf_pages: info.pages, processed_pdf_pages: index + 1, page,
    });
  }
  const toc = documentMapTocEntries(samples);
  const parts = [
    '# Document Map',
    `- Source pages: ${info.pages}`,
    ...(info.title ? [`- Title: ${info.title}`] : []),
    '- Mode: progressive disclosure',
    '- This map is a navigation/index view, not the complete document.',
  ];
  if (toc.length) {
    parts.push('', '## Detected contents / section hints');
    for (const entry of toc) parts.push(`- ${entry.label} — listed page ${entry.page}`);
  }
  parts.push('', '## Page landmarks');
  for (const sample of samples) parts.push(`- p.${sample.page}: ${sample.heading}`);
  parts.push(
    '',
    '## Continue reading',
    '- Use Claude Code Read on the same file with Read.pages (for example pages="42" or pages="40-45") when detailed source evidence is required.',
    '- Do not infer unsampled page details from this map. Read the relevant page range before making evidence-dependent claims.',
  );
  const bounded = boundedText(parts.join('\n'), Math.min(limits.maxOutputChars, 120_000));
  const warnings = ['document_map_progressive_disclosure'];
  if (nativeTextPages === 0) warnings.push('document_map_low_text');
  if (bounded.truncated) warnings.push('proxy_output_char_limit');
  return {
    parser: 'poppler-document-map',
    document_mode: 'map',
    visual_used: false,
    page_count: info.pages,
    processed_pages: sampledPages.length,
    requested_pages: null,
    page_scope_mode: 'document_map',
    visual_batch_count: 0,
    classification_count: 0,
    sampled_pages: sampledPages,
    markdown: bounded.text,
    warnings,
    truncated: bounded.truncated,
    original_chars: bounded.originalChars,
    returned_chars: bounded.text.length,
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

function resolvePdfPagePlan(sourcePageCount, pageScope, maxPdfPages) {
  if (!pageScope) {
    if (sourcePageCount > maxPdfPages) throw new HttpError(413, 'PDF exceeds the configured page limit.', { code: 'pdf_page_limit' });
    return {
      focused: false,
      mode: 'whole_document',
      requestedPages: null,
      pages: Array.from({ length: sourcePageCount }, (_, index) => ({ physicalPage: index + 1, logicalPage: index + 1 })),
    };
  }
  const requestedPages = Array.isArray(pageScope.pages) ? [...pageScope.pages] : [];
  if (requestedPages.length < 1) throw new HttpError(422, 'PDF page scope is empty.', { code: 'invalid_pdf_page_scope' });
  if (requestedPages.length > maxPdfPages) throw new HttpError(413, 'PDF page scope exceeds the configured page limit.', { code: 'pdf_page_scope_limit' });
  const maximum = Math.max(...requestedPages);
  if (maximum <= sourcePageCount) {
    return {
      focused: true,
      mode: 'full_source',
      requestedPages,
      pages: requestedPages.map((page) => ({ physicalPage: page, logicalPage: page })),
    };
  }
  if (sourcePageCount === requestedPages.length) {
    return {
      focused: true,
      mode: 'subset_source',
      requestedPages,
      pages: requestedPages.map((logicalPage, index) => ({ physicalPage: index + 1, logicalPage })),
    };
  }
  throw new HttpError(422, 'Received PDF cannot represent the requested Read.pages scope.', { code: 'pdf_page_scope_unavailable' });
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
    classifyPage = defaultClassifyPdfPage, pageScope = null,
    documentMapPageThreshold = 20,
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
    const mapThreshold = Math.max(1, Math.min(Number(documentMapPageThreshold) || 20, limits.maxPdfPages));
    if (!pageScope && info.pages > mapThreshold) {
      await onProgress(`已確認來源 PDF ${info.pages} 頁；大型文件將先建立文件地圖…`, {
        phase: 'pdf_document_map_start', total: info.pages, received_pdf_pages: info.pages, processed_pdf_pages: 0,
      });
      return await buildPdfDocumentMap(inputPath, info, { limits, signal, runner, onProgress });
    }
    const pagePlan = resolvePdfPagePlan(info.pages, pageScope, limits.maxPdfPages);
    const selectedTotal = pagePlan.pages.length;
    const scopeLabel = pagePlan.focused ? `；指定頁面 ${pageScope.canonical}` : '';
    await onProgress(`已確認來源 PDF ${info.pages} 頁${scopeLabel}；正在抽取原生文字…`, {
      phase: 'pdf_metadata', total: selectedTotal, received_pdf_pages: info.pages, processed_pdf_pages: 0,
      ...(pagePlan.focused ? { requested_pages: pagePlan.requestedPages, page_scope: pageScope.canonical } : {}),
    });

    const pages = [];
    let insufficientCount = 0;
    for (const { physicalPage, logicalPage } of pagePlan.pages) {
      const textResult = await runner('pdftotext', ['-f', String(physicalPage), '-l', String(physicalPage), '-layout', '-nopgbrk', inputPath, '-'], {
        timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: Math.min(limits.maxOutputChars * 4, 16 * 1024 * 1024),
      });
      const nativeText = textResult.stdout.toString('utf8').replace(/\f/g, '').trim();
      const insufficient = nativeText.length < limits.nativeTextMinCharsPerPage;
      if (insufficient) insufficientCount += 1;
      pages.push({ page: logicalPage, physicalPage, nativeText, insufficient, route: 'TEXT', confidence: 1, reason: 'native text path' });
    }

    const visionEnabled = Boolean(vllmVisionUrl && vllmVisionModel);
    const warnings = [];
    if (insufficientCount === pages.length && !visionEnabled) {
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
      await onProgress(`正在分類 ${pages.length} 頁 PDF 內容…`, { phase: 'pdf_classify', total: pages.length });
      for (const page of pages) {
        const normalized = await renderPage(inputPath, directory, page.physicalPage, limits, signal, runner, dpi, 'classify');
        const size = pageDimensions(info, normalized, dpi);
        const registry = new VisualAssetRegistry();
        const asset = registry.add({
          ...normalized,
          label: `PDF page ${page.page} classification overview`,
          sourceKind: 'pdf_page',
          sourceMetadata: {
            pdfPath: inputPath, directory, page: page.physicalPage, logicalPage: page.page,
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
        page.rasterImage = rasterImagePages.has(page.physicalPage);
        if (page.route === 'TEXT' && page.rasterImage && page.confidence < 0.5) page.route = 'DENSE_PAGE';
        classificationCount += 1;
        await onProgress(`PDF 頁面分類 ${classificationCount}/${pages.length}…`, {
          phase: 'pdf_classify', completed: classificationCount, total: pages.length, page: page.page, route: page.route,
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
      const normalized = await renderPage(inputPath, directory, page.physicalPage, limits, signal, runner, standardDpi, 'overview');
      const size = pageDimensions(info, normalized, standardDpi);
      const asset = analysisRegistry.add({
        ...normalized,
        label: `PDF page ${page.page} ${page.route}`,
        sourceKind: 'pdf_page',
        sourceMetadata: {
          pdfPath: inputPath, directory, page: page.physicalPage, logicalPage: page.page,
          pageWidthPoints: size.width, pageHeightPoints: size.height, overviewDpi: standardDpi,
        },
      });
      genericEntries.get(page.route)?.push({ ...page, asset, size });
    }

    const analyzeZoomFallback = async (entry, overviewMarkdown, route) => {
      const tiles = buildPdfTiles(entry.size, { overlap: 0.15, targetLongEdgePx: 2300, dpi: 360, maxTiles: 12 });
      await onProgress(`第 ${entry.page} 頁內容過於密集；將切成 ${tiles.length} 個 overlapping zoom tiles…`, {
        phase: 'pdf_zoom_tile', page: entry.page, route, count: tiles.length, overlap: 0.15,
      });
      const commonOptions = visionCallOptions({
        vllmVisionUrl, vllmVisionModel, vllmVisionApiKey, vllmVisionProvider, vllmVisionThink,
        registry: analysisRegistry, signal, onProgress, cropImage, limits, runner,
      });
      const regionEvidence = [];
      for (let index = 0; index < tiles.length; index += 1) {
        const tile = tiles[index];
        await onProgress(`正在建立第 ${entry.page} 頁 zoom tile ${index + 1}/${tiles.length}…`, {
          phase: 'pdf_zoom_tile_render', page: entry.page, route, completed: index + 1, total: tiles.length, tile: tile.index,
        });
        const image = await renderPdfRegion(entry.asset, tile.bbox, 360, limits, signal, runner, `zoom-${tile.index}`);
        const asset = analysisRegistry.registerRegion(entry.asset.sourceId, image, {
          rootBox: tile.bbox,
          label: `PDF page ${entry.page} ${route} zoom tile ${tile.index}/${tiles.length}`,
          regionKind: 'zoom_tile',
          sourceMetadata: { tileIndex: tile.index, tileCount: tiles.length, tileBbox: tile.bbox, overlap: 0.15 },
        });
        await onProgress(`正在分析第 ${entry.page} 頁 zoom tile ${index + 1}/${tiles.length}…`, {
          phase: 'pdf_zoom_tile_analyze', page: entry.page, route, completed: index + 1, total: tiles.length, tile: tile.index,
        });
        try {
          const result = await analyzeVisualAssets([asset], {
            ...commonOptions,
            prompt: `Analyze zoom tile ${tile.index}/${tiles.length} for PDF page ${entry.page} (${route}). Extract only observable text, labels, arrows, table cells, nodes and relationships. This tile overlaps neighboring regions by 15 percent; use repeated labels and structures as continuity anchors. Preserve source_id and uncertainty. If an essential smaller region remains unreadable, use request_image_crop. Do not answer the final user task.`,
          });
          visualBatchCount += 1;
          warnings.push(...(result.warnings || []));
          regionEvidence.push({ sourceId: asset.sourceId, markdown: result.markdown });
        } catch (error) {
          const expectedVisionFailure = error instanceof HttpError && Boolean(error.retryable) && Number(error.status) >= 500;
          if (!expectedVisionFailure) throw error;
          visualBatchCount += 1;
          const code = String(error.code || 'vision_service_error').slice(0, 80);
          warnings.push(`pdf_zoom_tile_${code}`);
          regionEvidence.push({ sourceId: asset.sourceId, markdown: `Uncertain: zoom tile ${tile.index}/${tiles.length} evidence unavailable due to ${code}.` });
          await onProgress(`第 ${entry.page} 頁 zoom tile ${tile.index}/${tiles.length} 分析失敗；保留缺口並繼續。`, {
            phase: 'pdf_zoom_tile_failed', page: entry.page, route, tile: tile.index, code, retryable: Boolean(error.retryable),
          });
        }
      }
      return mergePageEvidence({
        page: entry.page,
        route,
        nativeText: entry.nativeText,
        overview: overviewMarkdown,
        regions: regionEvidence,
      });
    };

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
          allowNeedsZoomFallback: route === 'DIAGRAM' || route === 'DENSE_PAGE',
          prompt,
        });
        visualUsed = true;
        visualBatchCount += 1;
        warnings.push(...(result.warnings || []));
        if (result.needsZoom && (route === 'DIAGRAM' || route === 'DENSE_PAGE')) {
          for (const entry of batch) {
            const merged = await analyzeZoomFallback(entry, result.markdown, route);
            visualBatches.push({ pages: [entry.page], route, markdown: merged, cropCount: Number(result.cropCount || 0) });
          }
        } else {
          visualBatches.push({ pages: batch.map((entry) => entry.page), route, markdown: result.markdown, cropCount: result.cropCount });
        }
      }
    }

    for (const page of pages.filter((entry) => visionEnabled && entry.route === 'SCHEMATIC')) {
      const dpi = schematicOverviewDpi(info.pageSize);
      await onProgress(`正在準備第 ${page.page} 頁 schematic overview…`, { phase: 'pdf_schematic_overview', page: page.page });
      const normalized = await renderPage(inputPath, directory, page.physicalPage, limits, signal, runner, dpi, 'schematic-overview');
      const size = pageDimensions(info, normalized, dpi);
      const root = analysisRegistry.add({
        ...normalized,
        label: `PDF page ${page.page} schematic overview`,
        sourceKind: 'pdf_page',
        sourceMetadata: {
          pdfPath: inputPath, directory, page: page.physicalPage, logicalPage: page.page,
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

      const tiles = buildPdfTiles(size, { overlap: 0.20, targetLongEdgePx: 2300, dpi: 360, maxTiles: 12 });
      await onProgress(`第 ${page.page} 頁 schematic 將切成 ${tiles.length} 個 overlapping tiles…`, {
        phase: 'pdf_schematic_tile', page: page.page, count: tiles.length,
      });
      const tileEntries = [];
      for (const tile of tiles) {
        await onProgress(`正在建立第 ${page.page} 頁 schematic tile ${tile.index}/${tiles.length}…`, {
          phase: 'pdf_schematic_tile_render', page: page.page, completed: tile.index, total: tiles.length,
        });
        const image = await renderPdfRegion(root, tile.bbox, 360, limits, signal, runner, `tile-${tile.index}`);
        const asset = analysisRegistry.registerRegion(root.sourceId, image, {
          rootBox: tile.bbox,
          label: `PDF page ${page.page} schematic tile ${tile.index}/${tiles.length}`,
          regionKind: 'schematic_tile',
          sourceMetadata: { tileIndex: tile.index, tileCount: tiles.length, tileBbox: tile.bbox, overlap: 0.20 },
        });
        tileEntries.push({ page: page.page, tile, asset });
      }

      const regionEvidence = [];
      for (let index = 0; index < tileEntries.length; index += 1) {
        const entry = tileEntries[index];
        await onProgress(`正在分析第 ${page.page} 頁 schematic tile ${index + 1}/${tileEntries.length}…`, {
          phase: 'pdf_schematic_tile_analyze', page: page.page, completed: index + 1, total: tileEntries.length,
          tile: entry.tile.index,
        });
        try {
          const result = await analyzeVisualAssets([entry.asset], {
            ...commonOptions,
            prompt: `Analyze schematic tile ${entry.tile.index}/${tileEntries.length} for PDF page ${page.page}. Extract only observable components, reference designators, pins, net/signal labels, power rails, clocks, resets, bus connections and wire relationships. Preserve source_id. The tile overlaps neighboring regions; do not invent off-tile continuity when labels are unreadable. Request a precise crop only for an essential small region. Do not answer the final user task.`,
          });
          visualBatchCount += 1;
          warnings.push(...(result.warnings || []));
          regionEvidence.push({ sourceId: entry.asset.sourceId, markdown: result.markdown });
        } catch (error) {
          const expectedVisionFailure = error instanceof HttpError && Boolean(error.retryable) && Number(error.status) >= 500;
          if (!expectedVisionFailure) throw error;
          visualBatchCount += 1;
          const code = String(error.code || 'vision_service_error').slice(0, 80);
          warnings.push(`schematic_tile_${code}`);
          regionEvidence.push({
            sourceId: entry.asset.sourceId,
            markdown: `Uncertain: schematic tile ${entry.tile.index}/${tileEntries.length} evidence unavailable due to ${code}. Neighboring tile evidence may be incomplete.`,
          });
          await onProgress(`第 ${page.page} 頁 schematic tile ${entry.tile.index}/${tileEntries.length} 分析失敗；將保留缺口並繼續下一個 tile。`, {
            phase: 'pdf_schematic_tile_failed', page: page.page, tile: entry.tile.index,
            completed: index + 1, total: tileEntries.length, code, retryable: Boolean(error.retryable),
          });
        }
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
    await onProgress('PDF 內容已完成合併。', { phase: 'pdf_complete', completed: pages.length, total: pages.length, ...(pagePlan.focused ? { requested_pages: pagePlan.requestedPages, page_scope: pageScope.canonical } : {}) });
    return {
      parser: visualUsed ? 'poppler+visual-vllm' : 'poppler',
      document_mode: pagePlan.focused ? 'focused' : 'full',
      visual_used: visualUsed,
      page_count: info.pages,
      processed_pages: pages.length,
      requested_pages: pagePlan.requestedPages,
      page_scope_mode: pagePlan.mode,
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
