import fs from 'node:fs/promises';
import { HttpError } from '../lib/http.js';
import { buildMediaCacheKey, scopeMediaCacheKey, scopePdfDocumentCacheKey } from '../cache/cache-key.js';
import { boundedText, decodeBase64Media, detectMediaType } from '../lib/media.js';
import { parsePdf as defaultParsePdf } from '../parsers/pdf.js';
import { normalizeImage as defaultNormalizeImage, cropImage as defaultCropImage } from '../parsers/image.js';
import { VisualAssetRegistry } from '../visual/asset-registry.js';
import { analyzeVisualAssets as defaultAnalyzeVisualAssets } from '../visual/vision-client.js';
import { analyzeGenericZoomFallback } from '../visual/generic-zoom.js';
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
  const continuationCacheWriter = dependencies.continuationCacheWriter || (() => false);
  const continuationFreshMessageIndex = Number.isInteger(dependencies.continuationFreshMessageIndex)
    ? dependencies.continuationFreshMessageIndex
    : -1;
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
    visualPromptVersion: config.cache?.visualPromptVersion || 'visual-v18',
    evidenceContractVersion: config.cache?.evidenceContractVersion || 'evidence-v14',
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

  const cacheLookup = async (key, { bypassContinuationPreload = false } = {}) => {
    if (!key || !mediaCache) return null;
    if (preloadedCache.has(key)) {
      const preloaded = preloadedCache.get(key);
      const isContinuation = preloaded?.__vccSource === 'continuation' && preloaded?.__vccValue?.block;
      if (!(isContinuation && bypassContinuationPreload)) {
        const value = isContinuation ? preloaded.__vccValue : preloaded;
        onCacheEvent(isContinuation ? 'media_continuation_cache_hit' : 'media_cache_hit', {
          keyPrefix: key.slice(0, 12), source: 'preloaded',
        });
        return value;
      }
    }
    const value = await mediaCache.get(key);
    onCacheEvent(value ? 'media_cache_hit' : 'media_cache_miss', { keyPrefix: key.slice(0, 12) });
    return value;
  };

  const writeContinuation = (key, value) => {
    if (!key || !value?.block) return false;
    try { return continuationCacheWriter(key, structuredClone(value)); }
    catch (error) {
      onDiagnostic('media_continuation_cache_write_failed', { code: error?.code || error?.name || 'error' });
      return false;
    }
  };

  const cachedAnalysis = async (key, loadSource, producer, lookupOptions = {}) => {
    const cached = await cacheLookup(key, lookupOptions);
    if (cached?.block) {
      writeContinuation(key, cached);
      return structuredClone(cached.block);
    }
    const source = await loadSource();
    if (!key || !mediaCache) {
      const value = await producer(signal, source);
      writeContinuation(key, value);
      return structuredClone(value.block);
    }

    const run = async ({ signal: sharedSignal }) => {
      const lateHit = await mediaCache.get(key);
      if (lateHit?.block) {
        onCacheEvent('media_cache_hit', { keyPrefix: key.slice(0, 12), source: 'singleflight_recheck' });
        writeContinuation(key, lateHit);
        return lateHit;
      }
      const value = await producer(sharedSignal, source);
      writeContinuation(key, value);
      if (value?.cacheable === false) {
        onCacheEvent('media_cache_skip', { keyPrefix: key.slice(0, 12), reason: 'non_cacheable_terminal_evidence' });
        return value;
      }
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
          vllmVisionProvider: config.vllmVisionProvider, vllmVisionThink: config.vllmVisionThink, vllmVisionTimeoutMs: config.vllmVisionTimeoutMs,
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
      }, { bypassContinuationPreload: context.messageIndex === continuationFreshMessageIndex });
    },

    async adaptImage(block, context = {}) {
      const key = block.source.cache_key || '';
      const tracked = mediaProgress?.contextForPath(context.path);
      const filename = tracked?.filename || block.source.filename || block.title || context.filename || 'image';
      const provenance = {
        origin: tracked?.origin || 'direct',
        originTool: tracked?.originTool || '',
        sourceKind: tracked?.sourceKind || 'direct_image',
        readSourceRef: tracked?.readSourceRef || '',
        requestedPages: Array.isArray(tracked?.pageScope?.pages) ? tracked.pageScope.pages : null,
      };
      const nativeVisionPassthrough = config.vllmBaseVisionEnabled === true
        && config.visionNativePassthrough === true
        && ['direct_image', 'read_image'].includes(provenance.sourceKind);
      if (nativeVisionPassthrough) {
        if (block.source?.type === 'base64') {
          onVisionEvent('native_vision_raw_passthrough_selected', {
            media_type: block.source.media_type,
            origin: provenance.origin,
            origin_tool: provenance.originTool,
            source_kind: provenance.sourceKind,
            read_source_ref: provenance.readSourceRef,
          });
          onVisionEvent('native_vision_passthrough_selected', {
            media_type: block.source.media_type,
            origin: provenance.origin,
            origin_tool: provenance.originTool,
            source_kind: provenance.sourceKind,
            read_source_ref: provenance.readSourceRef,
            passthrough_mode: 'raw',
          });
          return structuredClone(block);
        }
        const sourceBuffer = await readSource(block.source, block.source.media_type);
        onVisionEvent('native_vision_passthrough_selected', {
          media_type: block.source.media_type,
          decoded_bytes: sourceBuffer.length,
          origin: provenance.origin,
          origin_tool: provenance.originTool,
          source_kind: provenance.sourceKind,
          read_source_ref: provenance.readSourceRef,
        });
        return {
          ...block,
          source: {
            type: 'base64',
            media_type: block.source.media_type,
            data: sourceBuffer.toString('base64'),
          },
        };
      }
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
          ...(tracked ? {
            origin: provenance.origin,
            origin_tool: provenance.originTool,
            source_kind: provenance.sourceKind,
            read_source_ref: provenance.readSourceRef,
            requested_pages: provenance.requestedPages,
          } : {}),
        });
        const registry = new VisualAssetRegistry();
        const asset = registry.add({
          ...normalized,
          label: filename || 'Claude Code image',
          sourceKind: provenance.sourceKind,
          sourceMetadata: { origin: provenance.origin, originTool: provenance.originTool, readSourceRef: provenance.readSourceRef, requestedPages: provenance.requestedPages },
          originalBuffer: sourceBuffer,
          originalMediaType: mediaType,
          originalWidth: normalized.originalWidth || normalized.width,
          originalHeight: normalized.originalHeight || normalized.height,
        });
        await reportProgress('正在使用視覺模型分析圖片…', { phase: 'image_vision' });
        let result = await analyzeWithAdmission([asset], {
          baseUrl: config.vllmVisionUrl, model: config.vllmVisionModel, apiKey: config.vllmVisionApiKey,
          provider: config.vllmVisionProvider, think: config.vllmVisionThink,
          registry, signal: analysisSignal, onProgress: reportProgress,
          allowNeedsZoomFallback: true,
          cropImage: (original, authorization, callOptions) => cropImage(original, authorization, { ...config.limits, ...callOptions }),
        });
        if (result.needsZoom) {
          const zoom = await analyzeGenericZoomFallback(asset, {
            registry, signal: analysisSignal, overlap: 0.15, maxTiles: 6,
            onProgress: reportProgress,
            isRecoverable: recoverableVisionFailure,
            cropImage: (original, authorization, callOptions) => cropImage(original, authorization, { ...config.limits, ...callOptions }),
            analyzeTile: async (tileAsset, tile) => analyzeWithAdmission([tileAsset], {
              baseUrl: config.vllmVisionUrl, model: config.vllmVisionModel, apiKey: config.vllmVisionApiKey,
              provider: config.vllmVisionProvider, think: config.vllmVisionThink,
              registry, signal: analysisSignal, onProgress: reportProgress, allowNeedsZoomFallback: false,
              recoveryContext: 'zoom_tile',
              timeoutMs: Math.min(config.vllmVisionTimeoutMs ?? 120000, 30000),
              prompt: `Analyze generic zoom tile ${tile.index}. This is the terminal deterministic zoom layer and overlaps adjacent tiles by 15 percent. Adapt to the visible content type. Extract directly visible text, labels, objects, controls, table cells, chart axes or values, diagram nodes or arrows, technical identifiers or connections, states and spatial relationships relevant to the original visual task. Repeated content near boundaries is a continuity anchor. If one precise smaller region remains necessary, use request_image_crop. If some details remain unresolved, preserve reliable partial evidence and uncertainty instead of guessing. Do not request another generic zoom. Do not answer the final user task.`,
              cropImage: (original, authorization, callOptions) => cropImage(original, authorization, { ...config.limits, ...callOptions }),
            }),
          });
          onDiagnostic('vision_zoom_summary', {
            tile_count: zoom.tileCount,
            resolved_count: zoom.resolvedCount,
            unresolved_count: zoom.unresolvedCount,
            partial_count: zoom.partialCount,
            failed_count: zoom.failedCount,
            budget_exhausted_count: zoom.budgetExhaustedCount,
            terminal_status: zoom.terminalStatus,
            cacheable: zoom.cacheable,
          });
          result = {
            ...result,
            markdown: `${result.markdown}\n\n${zoom.markdown}`,
            warnings: [...(result.warnings || []), ...(zoom.warnings || []), 'vision_generic_zoom_fallback'],
            cropCount: Number(result.cropCount || 0) + Number(zoom.cropCount || 0),
            needsZoom: zoom.unresolvedCount > 0,
            cacheable: zoom.cacheable,
            zoomTerminalStatus: zoom.terminalStatus,
          };
        }
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
            ...provenance,
          }),
        };
        return {
          block: normalizedBlock,
          cacheable: result.cacheable !== false,
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
        }, { bypassContinuationPreload: context.messageIndex === continuationFreshMessageIndex });
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
          origin: provenance.origin,
          origin_tool: provenance.originTool,
          source_kind: provenance.sourceKind,
          read_source_ref: provenance.readSourceRef,
        });
        const unavailableBlock = {
          type: 'text',
          text: formatUnavailableImageEvidence({
            sourceSha256: block.source.media_sha256 || '',
            mediaType: fallback.mediaType,
            width: fallback.width,
            height: fallback.height,
            visualModel: config.vllmVisionModel,
            errorCode,
            ...provenance,
          }),
        };
        writeContinuation(key, {
          block: unavailableBlock,
          cacheable: false,
          metadata: {
            mediaType: fallback.mediaType,
            width: fallback.width,
            height: fallback.height,
            visualModel: config.vllmVisionModel,
            errorCode,
            unavailable: true,
          },
        });
        return unavailableBlock;
      }
    },
  };
}
