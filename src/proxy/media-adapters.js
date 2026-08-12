import fs from 'node:fs/promises';
import { HttpError } from '../lib/http.js';
import { buildMediaCacheKey, scopeMediaCacheKey, scopePdfDocumentCacheKey } from '../cache/cache-key.js';
import { boundedText, decodeBase64Media, detectMediaType } from '../lib/media.js';
import { parsePdf as defaultParsePdf } from '../parsers/pdf.js';
import { normalizeImage as defaultNormalizeImage, cropImage as defaultCropImage } from '../parsers/image.js';
import { VisualAssetRegistry } from '../visual/asset-registry.js';
import { analyzeVisualAssets as defaultAnalyzeVisualAssets } from '../visual/vision-client.js';
import { formatDocumentEvidence, formatDocumentMapEvidence, formatImageEvidence, formatUnavailableImageEvidence } from './evidence-contract.js';
import { controlTagName, scanControlTags } from './protocol-sanitizer.js';

export function createMediaAdapters(config, signal, onProgress = () => {}, dependencies = {}) {
  const parsePdf = dependencies.parsePdf || defaultParsePdf;
  const normalizeImage = dependencies.normalizeImage || defaultNormalizeImage;
  const cropImage = dependencies.cropImage || defaultCropImage;
  const analyzeVisualAssets = dependencies.analyzeVisualAssets || defaultAnalyzeVisualAssets;
  const acquireVision = dependencies.acquireVision || (async () => () => {});
  const allowedMediaPaths = dependencies.allowedMediaPaths || new Set();
  const mediaCache = dependencies.mediaCache || null;
  const documentSourceCache = dependencies.documentSourceCache || null;
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

  const mediaFingerprint = (buffer, mediaType = 'application/pdf') => buildMediaCacheKey({
    buffer,
    mediaType,
    pipelineVersion: config.cache?.pipelineVersion || 'media-v8',
    visualPromptVersion: config.cache?.visualPromptVersion || 'visual-v13',
    evidenceContractVersion: config.cache?.evidenceContractVersion || 'evidence-v9',
    visionModel: config.vllmVisionModel || '',
    visionProvider: config.vllmVisionProvider || 'vllm',
    visionApiProtocol: config.vllmVisionApiProtocol || 'openai-chat',
    visionThink: Boolean(config.vllmVisionThink),
    resourceProfile: config.resourceProfile || 'default',
  });

  const analyzeWithAdmission = async (assets, options) => {
    const release = await acquireVision({ signal: options?.signal || signal });
    try {
      return await analyzeVisualAssets(assets, {
        ...options,
        timeoutMs: options?.timeoutMs ?? config.vllmVisionTimeoutMs ?? 120000,
        onDiagnostic,
        onEvent: onVisionEvent,
      });
    } finally {
      release();
    }
  };

  const recoverableVisionFailure = (error) => Boolean(error?.retryable) && [
    'vision_service_error',
    'vision_service_timeout',
    'vision_empty_output',
    'vision_output_invalid',
    'vision_invalid_response',
  ].includes(error?.code);

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
      const tracked = mediaProgress?.contextForPath(context.path);
      if (tracked?.pageScopeError) {
        throw new HttpError(422, tracked.pageScopeError.message || 'Invalid PDF page scope.', { code: tracked.pageScopeError.code || 'invalid_pdf_page_scope' });
      }
      const pageScope = tracked?.pageScope || null;
      const readSourceRef = tracked?.readSourceRef || '';
      let cachedOriginal = null;
      if (pageScope && readSourceRef && documentSourceCache) {
        try { cachedOriginal = await documentSourceCache.resolve(readSourceRef); }
        catch (error) { onDiagnostic('document_source_cache_read_failed', { code: error?.code || error?.name || 'error' }); }
      }
      let baseKey = block.source.cache_key || '';
      let effectiveSourceSha256 = block.source.media_sha256 || '';
      if (cachedOriginal?.buffer) {
        const fingerprint = mediaFingerprint(cachedOriginal.buffer, 'application/pdf');
        baseKey = fingerprint.key;
        effectiveSourceSha256 = cachedOriginal.sourceSha256 || fingerprint.mediaSha256;
      }
      const key = scopePdfDocumentCacheKey(baseKey, pageScope);
      const filename = tracked?.filename || block.source.filename || block.title || context.filename || cachedOriginal?.filename || 'document.pdf';
      const reportProgress = (message, details = {}) => onProgress(message, { ...details, path: context.path, filename });
      return cachedAnalysis(key, () => cachedOriginal?.buffer ? Buffer.from(cachedOriginal.buffer) : readSource(block.source, 'application/pdf'), async (analysisSignal, buffer) => {
        const fingerprint = mediaFingerprint(buffer, 'application/pdf');
        if (!effectiveSourceSha256) effectiveSourceSha256 = fingerprint.mediaSha256;
        if (!pageScope && readSourceRef && documentSourceCache) {
          try {
            await documentSourceCache.put({ readSourceRef, sourceSha256: fingerprint.mediaSha256, buffer, filename });
          } catch (error) {
            onDiagnostic('document_source_cache_write_failed', { code: error?.code || error?.name || 'error' });
          }
        }
        await reportProgress('正在解析 PDF…', { phase: 'pdf_start' });
        const result = await parsePdf(buffer, {
          limits: config.limits, signal: analysisSignal, onProgress: reportProgress, pageScope,
          documentMapPageThreshold: config.limits?.documentMapPageThreshold ?? 20,
          vllmVisionUrl: config.vllmVisionUrl, vllmVisionModel: config.vllmVisionModel, vllmVisionApiKey: config.vllmVisionApiKey,
          vllmVisionProvider: config.vllmVisionProvider, vllmVisionThink: config.vllmVisionThink,
          analyzeVisualAssets: analyzeWithAdmission, cropImage,
        });
        const bounded = boundedText(result.markdown || '', maxOutputChars);
        const warnings = [...(result.warnings || []), ...(bounded.truncated ? ['proxy_output_char_limit'] : [])];
        diagnoseSourceControlTags(bounded.text);
        const isDocumentMap = result.document_mode === 'map';
        const normalizedBlock = {
          type: 'text',
          text: isDocumentMap
            ? formatDocumentMapEvidence({
              filename,
              sourceSha256: effectiveSourceSha256,
              parser: result.parser || 'poppler-document-map',
              pages: result.page_count ?? null,
              sampledPages: result.sampled_pages || [],
              content: bounded.text,
              warnings,
            })
            : formatDocumentEvidence({
              filename,
              sourceSha256: effectiveSourceSha256,
              parser: result.parser || 'unknown',
              pages: result.page_count ?? null,
              processedPages: result.processed_pages ?? result.page_count ?? null,
              requestedPages: result.requested_pages || null,
              pageScopeMode: result.page_scope_mode || '',
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
            mediaType: 'application/pdf', documentMode: result.document_mode || 'full', pages: result.page_count ?? null,
            processedPages: result.processed_pages ?? result.page_count ?? null, sampledPages: result.sampled_pages || [],
            requestedPages: result.requested_pages || null, pageScopeMode: result.page_scope_mode || '',
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
      const fallback = {
        mediaType: block.source.media_type,
        width: null,
        height: null,
      };
      try {
        return await cachedAnalysis(key, () => readSource(block.source, block.source.media_type), async (analysisSignal, sourceBuffer) => {
        const mediaType = block.source.media_type;
        await reportProgress('正在準備圖片…', { phase: 'image_start' });
        const normalized = await normalizeImage(sourceBuffer, { ...config.limits, signal: analysisSignal });
        fallback.mediaType = normalized.mediaType || mediaType;
        fallback.width = normalized.width;
        fallback.height = normalized.height;
        const receivedWidth = normalized.originalWidth || normalized.width;
        const receivedHeight = normalized.originalHeight || normalized.height;
        onDiagnostic('image_payload_normalized', {
          media_type: mediaType,
          decoded_bytes: sourceBuffer.length,
          received_width: receivedWidth,
          received_height: receivedHeight,
          normalized_width: normalized.width,
          normalized_height: normalized.height,
          wire_dimensions: block.source.wire_dimensions || {},
        });
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
            mediaType: normalized.mediaType,
            width: normalized.width,
            height: normalized.height,
            receivedWidth,
            receivedHeight,
            normalizedWidth: normalized.width,
            normalizedHeight: normalized.height,
            visualModel: config.vllmVisionModel,
            cropCount: result.cropCount,
            warnings,
            truncated: bounded.truncated,
          },
        };
        });
      } catch (error) {
        if (!recoverableVisionFailure(error)) throw error;
        const errorCode = String(error.code || 'vision_service_error').slice(0, 80);
        await reportProgress('圖片分析失敗，已略過並繼續處理其他附件。', {
          phase: 'image_vision_unavailable',
          error_code: errorCode,
        });
        onDiagnostic('image_vision_unavailable', {
          error_code: errorCode,
          retryable: true,
          media_type: fallback.mediaType,
          width: fallback.width,
          height: fallback.height,
        });
        return {
          type: 'text',
          text: formatUnavailableImageEvidence({
            sourceSha256: block.source.media_sha256 || '',
            mediaType: fallback.mediaType,
            width: fallback.width,
            height: fallback.height,
            visualModel: config.vllmVisionModel,
            errorCode,
          }),
        };
      }
    },
  };
}
