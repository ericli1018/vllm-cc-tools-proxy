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

function overviewDpi(pageSize, { targetLongEdge = 3500, minDpi = 220, maxDpi = 320 } = {}) {
  if (!pageSize) return 300;
  const longEdgePoints = Math.max(pageSize.width, pageSize.height);
  const dpi = Math.round((targetLongEdge * 72) / longEdgePoints);
  return Math.max(minDpi, Math.min(maxDpi, dpi));
}

async function renderPage(inputPath, directory, page, limits, signal, runner, dpi) {
  const prefix = path.join(directory, `page-${page}`);
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
  const [leftN, topN, rightN, bottomN] = authorization.rootBox;
  const pageWidthPx = (pageWidthPoints * dpi) / 72;
  const pageHeightPx = (pageHeightPoints * dpi) / 72;
  const left = Math.floor((leftN / 1000) * pageWidthPx);
  const top = Math.floor((topN / 1000) * pageHeightPx);
  const right = Math.ceil((rightN / 1000) * pageWidthPx);
  const bottom = Math.ceil((bottomN / 1000) * pageHeightPx);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const prefix = path.join(metadata.directory, `page-${page}-crop-${authorization.sourceId}-${authorization.depth}-${leftN}-${topN}-${rightN}-${bottomN}`);
  await runner('pdftoppm', [
    '-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', String(dpi),
    '-x', String(left), '-y', String(top), '-W', String(width), '-H', String(height),
    metadata.pdfPath, prefix,
  ], { timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: 2 * 1024 * 1024 });
  const normalized = await normalizeImage(await fs.readFile(`${prefix}.png`), { ...limits, signal, runner });
  return { ...normalized, renderDpi: dpi };
}

export async function parsePdf(buffer, options) {
  const {
    limits, onProgress = () => {}, signal, runner = runCommand,
    vllmVisionUrl = '', vllmVisionModel = '', vllmVisionApiKey = '',
    vllmVisionProvider = 'vllm', vllmVisionThink = false,
    analyzeVisualAssets = defaultAnalyzeVisualAssets, cropImage = defaultCropImage,
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
      phase: 'pdf_metadata',
      total: info.pages,
      received_pdf_pages: info.pages,
      processed_pdf_pages: 0,
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
      pages.push({ page, nativeText, insufficient });
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

    const visualBatches = [];
    let visualUsed = false;
    const selectedVisualPages = visionEnabled
      ? pages.filter((page) => page.insufficient || rasterImagePages.has(page.page))
      : [];
    if (selectedVisualPages.length > 0) {
      await onProgress(`正在準備 ${selectedVisualPages.length} 頁視覺內容…`, { phase: 'pdf_visual_prepare', total: selectedVisualPages.length });
      const registry = new VisualAssetRegistry();
      const visualPages = [];
      const dpi = overviewDpi(info.pageSize);
      for (const page of selectedVisualPages) {
        const normalized = await renderPage(inputPath, directory, page.page, limits, signal, runner, dpi);
        const pageWidthPoints = info.pageSize?.width || ((normalized.originalWidth || normalized.width) * 72) / dpi;
        const pageHeightPoints = info.pageSize?.height || ((normalized.originalHeight || normalized.height) * 72) / dpi;
        const asset = registry.add({
          ...normalized,
          label: `PDF page ${page.page}`,
          sourceKind: 'pdf_page',
          sourceMetadata: {
            pdfPath: inputPath,
            directory,
            page: page.page,
            pageWidthPoints,
            pageHeightPoints,
            overviewDpi: dpi,
          },
        });
        visualPages.push({ ...page, asset });
      }
      const batches = batchVisualPages(visualPages, limits.maxVisualPagesPerBatch || 4);
      await onProgress(`已接收 ${info.pages} 頁 PDF；其中 ${selectedVisualPages.length} 頁將分成 ${batches.length} 批進行視覺分析…`, {
        phase: 'pdf_visual_plan',
        received_pdf_pages: info.pages,
        selected_visual_pages: selectedVisualPages.length,
        visual_batch_size: limits.maxVisualPagesPerBatch || 4,
        visual_batch_count: batches.length,
      });
      let completed = 0;
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        await onProgress(`正在使用視覺模型分析第 ${index + 1}/${batches.length} 批頁面…`, { phase: 'pdf_visual_batch', batch: index + 1, batches: batches.length });
        const result = await analyzeVisualAssets(batch.map((entry) => entry.asset), {
          baseUrl: vllmVisionUrl, model: vllmVisionModel, apiKey: vllmVisionApiKey,
          provider: vllmVisionProvider, think: vllmVisionThink, registry, signal, onProgress,
          cropImage: (asset, authorization, callOptions) => asset?.sourceKind === 'pdf_page'
            ? renderPdfCrop(asset, authorization, { ...limits, ...callOptions }, callOptions?.signal || signal, runner)
            : cropImage(asset, authorization, { ...limits, ...callOptions, runner }),
          prompt: `Analyze PDF pages ${batch.map((entry) => entry.page).join(', ')}. Preserve each source_id and page number. Extract visible text when native text is missing; identify tables, diagrams, arrows, labels and relationships. Do not answer the final user task.`,
        });
        visualUsed = true;
        completed += batch.length;
        visualBatches.push({ pages: batch.map((entry) => entry.page), markdown: result.markdown, cropCount: result.cropCount });
        warnings.push(...(result.warnings || []));
        await onProgress(`視覺模型已完成 ${completed}/${selectedVisualPages.length} 個選定頁面…`, {
          phase: 'pdf_visual_progress',
          completed,
          total: selectedVisualPages.length,
          processed_pdf_pages: completed,
          received_pdf_pages: info.pages,
          visual_batch_count: batches.length,
        });
      }
    }

    const parts = [];
    for (const page of pages) {
      parts.push([
        `[VCC_PDF_PAGE_BEGIN index=${page.page} native_text_chars=${page.nativeText.length}]`,
        page.nativeText,
        '[VCC_PDF_PAGE_END]',
      ].join('\n'));
    }
    for (const batch of visualBatches) {
      parts.push([
        `[VCC_PDF_VISUAL_BATCH_BEGIN pages=${batch.pages.join(',')} crop_count=${batch.cropCount}]`,
        batch.markdown,
        '[VCC_PDF_VISUAL_BATCH_END]',
      ].join('\n'));
    }
    const bounded = boundedText(parts.join('\n\n'), limits.maxOutputChars);
    if (bounded.truncated) warnings.push('output_char_limit');
    await onProgress('PDF 內容已完成合併。', { phase: 'pdf_complete', completed: info.pages, total: info.pages });
    return {
      parser: visualUsed ? 'poppler+visual-vllm' : 'poppler', visual_used: visualUsed,
      page_count: info.pages, processed_pages: info.pages, visual_batch_count: visualBatches.length, markdown: bounded.text,
      warnings: [...new Set(warnings)], truncated: bounded.truncated,
      original_chars: bounded.originalChars, returned_chars: bounded.text.length,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
