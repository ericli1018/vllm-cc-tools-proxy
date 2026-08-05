import fs from 'node:fs/promises';
import { HttpError } from '../lib/http.js';
import { boundedText, decodeBase64Media, detectMediaType, xmlAttribute } from '../lib/media.js';
import { parsePdf as defaultParsePdf } from '../parsers/pdf.js';
import { normalizeImage as defaultNormalizeImage, cropImage as defaultCropImage } from '../parsers/image.js';
import { VisualAssetRegistry } from '../visual/asset-registry.js';
import { analyzeVisualAssets as defaultAnalyzeVisualAssets } from '../visual/vision-client.js';

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
  const { maxDecodedBytes, maxOutputChars } = config.limits;

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
      return await analyzeVisualAssets(assets, options);
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
      return cachedAnalysis(key, () => readSource(block.source, 'application/pdf'), async (analysisSignal, buffer) => {
        const filename = block.source.filename || block.title || context.filename || 'document.pdf';
        await onProgress('正在解析 PDF…', { phase: 'pdf_start', path: context.path });
        const result = await parsePdf(buffer, {
          limits: config.limits, signal: analysisSignal, onProgress,
          vllmVisionUrl: config.vllmVisionUrl, vllmVisionModel: config.vllmVisionModel, vllmVisionApiKey: config.vllmVisionApiKey,
          analyzeVisualAssets: analyzeWithAdmission, cropImage,
        });
        const bounded = boundedText(result.markdown || '', maxOutputChars);
        const warnings = [...(result.warnings || []), ...(bounded.truncated ? ['proxy_output_char_limit'] : [])];
        const attributes = [
          `filename="${xmlAttribute(filename)}"`, 'media_type="application/pdf"',
          `source_sha256="${xmlAttribute(block.source.media_sha256 || '')}"`,
          `parser="${xmlAttribute(result.parser || 'unknown')}"`, `pages="${xmlAttribute(result.page_count ?? '')}"`,
          `processed_pages="${xmlAttribute(result.processed_pages ?? result.page_count ?? '')}"`,
          `visual_used="${Boolean(result.visual_used)}"`, `truncated="${Boolean(result.truncated || bounded.truncated)}"`,
        ].join(' ');
        const normalizedBlock = { type: 'text', text: `<document ${attributes}>\n${bounded.text}${warnings.length ? `\n<warnings>${warnings.map(xmlAttribute).join(',')}</warnings>` : ''}\n</document>` };
        return {
          block: normalizedBlock,
          metadata: {
            mediaType: 'application/pdf', pages: result.page_count ?? null, parser: result.parser || 'unknown',
            visualUsed: Boolean(result.visual_used), warnings, truncated: Boolean(result.truncated || bounded.truncated),
          },
        };
      });
    },

    async adaptImage(block, context = {}) {
      const key = block.source.cache_key || '';
      return cachedAnalysis(key, () => readSource(block.source, block.source.media_type), async (analysisSignal, sourceBuffer) => {
        const mediaType = block.source.media_type;
        await onProgress('正在準備圖片…', { phase: 'image_start', path: context.path });
        const normalized = await normalizeImage(sourceBuffer, { ...config.limits, signal: analysisSignal });
        const registry = new VisualAssetRegistry();
        const asset = registry.add({ ...normalized, label: context.filename || 'Claude Code image' });
        await onProgress('正在使用視覺模型分析圖片…', { phase: 'image_vision', path: context.path });
        const result = await analyzeWithAdmission([asset], {
          baseUrl: config.vllmVisionUrl, model: config.vllmVisionModel, apiKey: config.vllmVisionApiKey,
          registry, signal: analysisSignal, onProgress,
          cropImage: (original, authorization, callOptions) => cropImage(original, authorization, { ...config.limits, ...callOptions }),
        });
        const bounded = boundedText(result.markdown || '', maxOutputChars);
        const warnings = [...(result.warnings || []), ...(bounded.truncated ? ['proxy_output_char_limit'] : [])];
        const normalizedBlock = { type: 'text', text: `<visual_asset source_id="${asset.sourceId}" source_sha256="${xmlAttribute(block.source.media_sha256 || '')}" media_type="${xmlAttribute(normalized.mediaType)}" width="${normalized.width}" height="${normalized.height}" visual_model="${xmlAttribute(config.vllmVisionModel)}" crop_count="${result.cropCount}" truncated="${bounded.truncated}">\n<analysis>\n${bounded.text}\n</analysis>${warnings.length ? `\n<warnings>${warnings.map(xmlAttribute).join(',')}</warnings>` : ''}\n</visual_asset>` };
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
