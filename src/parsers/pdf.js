import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../lib/http.js';
import { boundedText, detectMediaType, xmlAttribute } from '../lib/media.js';
import { runCommand } from '../lib/process.js';
import { normalizeImage, cropImage as defaultCropImage } from './image.js';
import { VisualAssetRegistry } from '../visual/asset-registry.js';
import { analyzeVisualAssets as defaultAnalyzeVisualAssets } from '../visual/vision-client.js';
import { batchVisualPages } from '../visual/pdf-batcher.js';

function parsePdfInfo(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) values[match[1].trim().toLowerCase().replaceAll(' ', '_')] = match[2].trim();
  }
  return { pages: Number.parseInt(values.pages || '0', 10), encrypted: /^yes/i.test(values.encrypted || ''), title: values.title || '' };
}

async function renderPage(inputPath, directory, page, limits, signal, runner) {
  const prefix = path.join(directory, `page-${page}`);
  await runner('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-r', '180', inputPath, prefix], {
    timeoutMs: limits.processTimeoutMs, signal, maxOutputBytes: 2 * 1024 * 1024,
  });
  return normalizeImage(await fs.readFile(`${prefix}.png`), { ...limits, signal, runner });
}

export async function parsePdf(buffer, options) {
  const {
    limits, onProgress = () => {}, signal, runner = runCommand,
    vllmVisionUrl = '', vllmVisionModel = '', vllmVisionApiKey = '',
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
    await onProgress(`已確認 ${info.pages} 頁；正在抽取原生文字…`, { phase: 'pdf_metadata', total: info.pages });

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
    const visualBatches = [];
    let visualUsed = false;
    if (visionEnabled) {
      await onProgress(`正在準備 ${info.pages} 頁視覺內容…`, { phase: 'pdf_visual_prepare', total: info.pages });
      const registry = new VisualAssetRegistry();
      const visualPages = [];
      for (const page of pages) {
        const normalized = await renderPage(inputPath, directory, page.page, limits, signal, runner);
        const asset = registry.add({ ...normalized, label: `PDF page ${page.page}` });
        visualPages.push({ ...page, asset });
      }
      const batches = batchVisualPages(visualPages, limits.maxVisualPagesPerBatch || 4);
      let completed = 0;
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        await onProgress(`正在使用視覺模型分析第 ${index + 1}/${batches.length} 批頁面…`, { phase: 'pdf_visual_batch', batch: index + 1, batches: batches.length });
        const result = await analyzeVisualAssets(batch.map((entry) => entry.asset), {
          baseUrl: vllmVisionUrl, model: vllmVisionModel, apiKey: vllmVisionApiKey, registry, signal, onProgress,
          cropImage: (asset, authorization, callOptions) => cropImage(asset, authorization, { ...limits, ...callOptions, runner }),
          prompt: `Analyze PDF pages ${batch.map((entry) => entry.page).join(', ')}. Preserve each source_id and page number. Extract visible text when native text is missing; identify tables, diagrams, arrows, labels and relationships. Do not answer the final user task.`,
        });
        visualUsed = true;
        completed += batch.length;
        visualBatches.push({ pages: batch.map((entry) => entry.page), markdown: result.markdown, cropCount: result.cropCount });
        warnings.push(...(result.warnings || []));
        await onProgress(`視覺模型已完成 ${completed}/${info.pages} 頁…`, { phase: 'pdf_visual_progress', completed, total: info.pages });
      }
    }

    const parts = [];
    for (const page of pages) {
      parts.push(`<page index="${page.page}" native_text_chars="${page.nativeText.length}">\n<native_text>\n${page.nativeText}\n</native_text>\n</page>`);
    }
    for (const batch of visualBatches) {
      parts.push(`<visual_batch pages="${batch.pages.join(',')}" crop_count="${batch.cropCount}">\n${batch.markdown}\n</visual_batch>`);
    }
    const bounded = boundedText(parts.join('\n\n'), limits.maxOutputChars);
    if (bounded.truncated) warnings.push('output_char_limit');
    await onProgress('PDF 內容已完成合併。', { phase: 'pdf_complete', completed: info.pages, total: info.pages });
    return {
      parser: visualUsed ? 'poppler+visual-vllm' : 'poppler', visual_used: visualUsed,
      page_count: info.pages, processed_pages: info.pages, markdown: bounded.text,
      warnings: [...new Set(warnings)], truncated: bounded.truncated,
      original_chars: bounded.originalChars, returned_chars: bounded.text.length,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
