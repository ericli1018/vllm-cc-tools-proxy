import fs from 'node:fs/promises';
import { HttpError } from '../lib/http.js';
import { boundedText, decodeBase64Media, detectMediaType } from '../lib/media.js';
import { parsePdf as defaultParsePdf } from '../parsers/pdf.js';
import { normalizeImage as defaultNormalizeImage, cropImage as defaultCropImage } from '../parsers/image.js';
import { VisualAssetRegistry } from '../visual/asset-registry.js';
import { analyzeVisualAssets as defaultAnalyzeVisualAssets } from '../visual/vision-client.js';
import { formatDocumentEvidence, formatImageEvidence } from './evidence-contract.js';
import { controlTagName, scanControlTags } from './protocol-sanitizer.js';

export function createMediaAdapters(config, signal, onProgress = () => {}, dependencies = {}) {
  const parsePdf = dependencies.parsePdf || defaultParsePdf;
  const normalizeImage = dependencies.normalizeImage || defaultNormalizeImage;
  const cropImage = dependencies.cropImage || defaultCropImage;
  const analyzeVisualAssets = dependencies.analyzeVisualAssets || defaultAnalyzeVisualAssets;
  const acquireVision = dependencies.acquireVision || (async () => () => {});
  const allowedMediaPaths = dependencies.allowedMediaPaths || new Set();
  const mediaCache = dependencies.mediaCache || null;
  const analysisRegistry = dependencies.analysisRegistry || null;
  const preloadedCache = dependencies.preloadedCache || new Map();
  const onCacheEvent = dependencies.onCacheEvent || (() => {});
  const onDiagnostic = dependencies.onDiagnostic || (() => {});
  const onVisionEvent = dependencies.onVisionEvent || (() => {});
  const mediaProgress = dependencies.mediaProgress || null;
  const { maxDecodedBytes, maxOutputChars } = config.limits;

  const diagnoseSourceControlTags = (value) => {
    const controlTags = scanControlTags(value);
    if (controlTags.length === 0) return;
    onDiagnostic('evidence_source_control_tags_detected', {
      tagCount: controlTags.length,
      tags: [...new Set(controlTags.map(controlTagName))],
    });
  };

  const readSource = async (source, expectedMediaType) => {
    if (source?.type === 'base64') return decodeBase64Media(source.data, maxDecodedBytes, expectedMediaType);
    if (source?.type !== 'proxy_file' || !allowedMediaPaths.has(source.path)) {
      throw new HttpError(422, 'Media handle is not authorized for this request.', { code: 'invalid_media_handle' });
    }
    const buffer = await fs.readFile(source.path);
    if (buffer.length > maxDecodedBytes) throw new HttpError(413, 'Decoded media exceeds the configured resource profile.', { code: 'media_too_large' });
    if (detectMediaType(buffer) !== expectedMediaType) {
      throw new HttpError(422, 'Media handle content does not match its declared type.', { code: 'media_magic_mismatch' });
    }
    return buffer;
  };

  const analyzeWithAdmission = async (assets, options) => {
    const release = await acquireVision({ signal: options?.signal || signal });
    try {
      return await analyzeVisualAssets(assets, { ...options, onDiagnostic, onEvent: onVisionEvent });
    } finally {
      release();
    }
  };

  const cacheLookup = async (key) => {
    if (!key || !mediaCache) return null;
    if (preloadedCache.has(key)) {
      const value = preloadedCache.get(key);
      onCacheEvent('media_cache_hit', { keyPrefix: key.slice(0, 12), source: 'preloaded' });
      return value;
    }
    const value = await mediaCache.get(key);
    onCacheEvent(value ? 'media_cache_hit' : 'media_cache_miss', { keyPrefix: key.slice(0, 12) });
    return value;
  };

  const cachedAnalysis = async (key, loadSource, producer) => {
    const cached = await cacheLookup(key);
    if (cached?.block) return structuredClone(cached.block);
    const source = await loadSource();
    if (!key || !mediaCache) return (await producer(signal, source)).block;

    const run = async ({ signal: sharedSignal }) => {
      const lateHit = await mediaCache.get(key);
      if (lateHit?.block) {
        onCacheEvent('media_cache_hit', { keyPrefix: key.slice(0, 12), source: 'singleflight_recheck' });
        return lateHit;
      }
      const value = await producer(sharedSignal, source);
      const stored = await mediaCache.set(key, value);
      onCacheEvent(stored ? 'media_cache_write' : 'media_cache_write_failed', { keyPrefix: key.slice(0, 12) });
      return value;
    };

    const value = analysisRegistry
      ? await analysisRegistry.run(key, run, { signal })
      : await run({ signal });
    return structuredClone(value.block);
  };

  return {
    async adaptDocument(block, context = {}) {
      const key = block.source.cache_key || '';
      const tracked = mediaProgress?.contextForPath(context.path);
      const filename = tracked?.filename || block.source.filename || block.title || context.filename || 'document.pdf';
      const reportProgress = (message, details = {}) => onProgress(message, { ...details, path: context.path, filename });
      return cachedAnalysis(key, () => readSource(block.source, 'application/pdf'), async (analysisSignal, buffer) => {
        await reportProgress('正在解析 PDF…', { phase: 'pdf_start' });
        const result = await parsePdf(buffer, {
          limits: config.limits, signal: analysisSignal, onProgress: reportProgress,
          vllmVisionUrl: config.vllmVisionUrl, vllmVisionModel: config.vllmVisionModel, vllmVisionApiKey: config.vllmVisionApiKey,
          vllmVisionProvider: config.vllmVisionProvider, vllmVisionThink: config.vllmVisionThink,
          analyzeVisualAssets: analyzeWithAdmission, cropImage,
        });
        const bounded = boundedText(result.markdown || '', maxOutputChars);
        const warnings = [...(result.warnings || []), ...(bounded.truncated ? ['proxy_output_char_limit'] : [])];
        diagnoseSourceControlTags(bounded.text);
        const normalizedBlock = {
          type: 'text',
          text: formatDocumentEvidence({
            filename,
            sourceSha256: block.source.media_sha256 || '',
            parser: result.parser || 'unknown',
            pages: result.page_count ?? null,
            processedPages: result.processed_pages ?? result.page_count ?? null,
            visualBatchCount: result.visual_batch_count ?? 0,
            visualUsed: Boolean(result.visual_used),
            truncated: Boolean(result.truncated || bounded.truncated),
            content: bounded.text,
            warnings,
          }),
        };
        return {
          block: normalizedBlock,
          metadata: {
            mediaType: 'application/pdf', pages: result.page_count ?? null, processedPages: result.processed_pages ?? result.page_count ?? null,
            visualBatchCount: result.visual_batch_count ?? 0, parser: result.parser || 'unknown',
            visualUsed: Boolean(result.visual_used), warnings, truncated: Boolean(result.truncated || bounded.truncated),
          },
        };
      });
    },

    async adaptImage(block, context = {}) {
      const key = block.source.cache_key || '';
      const tracked = mediaProgress?.contextForPath(context.path);
      const filename = tracked?.filename || block.source.filename || block.title || context.filename || 'image';
      const reportProgress = (message, details = {}) => onProgress(message, { ...details, path: context.path, filename });
      return cachedAnalysis(key, () => readSource(block.source, block.source.media_type), async (analysisSignal, sourceBuffer) => {
        const mediaType = block.source.media_type;
        await reportProgress('正在準備圖片…', { phase: 'image_start' });
        const normalized = await normalizeImage(sourceBuffer, { ...config.limits, signal: analysisSignal });
        const registry = new VisualAssetRegistry();
        const asset = registry.add({
          ...normalized,
          label: filename || 'Claude Code image',
          sourceKind: 'image',
          originalBuffer: sourceBuffer,
          originalMediaType: mediaType,
          originalWidth: normalized.originalWidth || normalized.width,
          originalHeight: normalized.originalHeight || normalized.height,
        });
        await reportProgress('正在使用視覺模型分析圖片…', { phase: 'image_vision' });
        const result = await analyzeWithAdmission([asset], {
          baseUrl: config.vllmVisionUrl, model: config.vllmVisionModel, apiKey: config.vllmVisionApiKey,
          provider: config.vllmVisionProvider, think: config.vllmVisionThink,
          registry, signal: analysisSignal, onProgress: reportProgress,
          cropImage: (original, authorization, callOptions) => cropImage(original, authorization, { ...config.limits, ...callOptions }),
        });
        await reportProgress('圖片分析已完成。', { phase: 'image_complete', completed: 1, total: 1 });
        const bounded = boundedText(result.markdown || '', maxOutputChars);
        const warnings = [...(result.warnings || []), ...(bounded.truncated ? ['proxy_output_char_limit'] : [])];
        diagnoseSourceControlTags(bounded.text);
        const normalizedBlock = {
          type: 'text',
          text: formatImageEvidence({
            sourceId: asset.sourceId,
            sourceSha256: block.source.media_sha256 || '',
            mediaType: normalized.mediaType,
            width: normalized.width,
            height: normalized.height,
            visualModel: config.vllmVisionModel,
            cropCount: result.cropCount,
            truncated: bounded.truncated,
            content: bounded.text,
            warnings,
          }),
        };
        return {
          block: normalizedBlock,
          metadata: {
            mediaType: normalized.mediaType, width: normalized.width, height: normalized.height,
            visualModel: config.vllmVisionModel, cropCount: result.cropCount, warnings, truncated: bounded.truncated,
          },
        };
      });
    },
  };
}
