import { boundedText, decodeBase64Media, xmlAttribute } from '../lib/media.js';
import { parsePdf as defaultParsePdf } from '../parsers/pdf.js';
import { normalizeImage as defaultNormalizeImage, cropImage as defaultCropImage } from '../parsers/image.js';
import { VisualAssetRegistry } from '../visual/asset-registry.js';
import { analyzeVisualAssets as defaultAnalyzeVisualAssets } from '../visual/vision-client.js';

export function createMediaAdapters(config, signal, onProgress = () => {}, dependencies = {}) {
  const parsePdf = dependencies.parsePdf || defaultParsePdf;
  const normalizeImage = dependencies.normalizeImage || defaultNormalizeImage;
  const cropImage = dependencies.cropImage || defaultCropImage;
  const analyzeVisualAssets = dependencies.analyzeVisualAssets || defaultAnalyzeVisualAssets;
  const { maxDecodedBytes, maxOutputChars } = config.limits;

  return {
    async adaptDocument(block, context = {}) {
      const buffer = decodeBase64Media(block.source.data, maxDecodedBytes, 'application/pdf');
      const filename = block.source.filename || block.title || context.filename || 'document.pdf';
      await onProgress('正在解析 PDF…', { phase: 'pdf_start', path: context.path });
      const result = await parsePdf(buffer, {
        limits: config.limits, signal, onProgress,
        vllmVisionUrl: config.vllmVisionUrl, vllmVisionModel: config.vllmVisionModel, vllmVisionApiKey: config.vllmVisionApiKey,
        analyzeVisualAssets, cropImage,
      });
      const bounded = boundedText(result.markdown || '', maxOutputChars);
      const warnings = [...(result.warnings || []), ...(bounded.truncated ? ['proxy_output_char_limit'] : [])];
      const attributes = [
        `filename="${xmlAttribute(filename)}"`, 'media_type="application/pdf"',
        `parser="${xmlAttribute(result.parser || 'unknown')}"`, `pages="${xmlAttribute(result.page_count ?? '')}"`,
        `processed_pages="${xmlAttribute(result.processed_pages ?? result.page_count ?? '')}"`,
        `visual_used="${Boolean(result.visual_used)}"`, `truncated="${Boolean(result.truncated || bounded.truncated)}"`,
      ].join(' ');
      return { type: 'text', text: `<document ${attributes}>\n${bounded.text}${warnings.length ? `\n<warnings>${warnings.map(xmlAttribute).join(',')}</warnings>` : ''}\n</document>` };
    },

    async adaptImage(block, context = {}) {
      const mediaType = block.source.media_type;
      const sourceBuffer = decodeBase64Media(block.source.data, maxDecodedBytes, mediaType);
      await onProgress('正在準備圖片…', { phase: 'image_start', path: context.path });
      const normalized = await normalizeImage(sourceBuffer, { ...config.limits, signal });
      const registry = new VisualAssetRegistry();
      const asset = registry.add({ ...normalized, label: context.filename || 'Claude Code image' });
      await onProgress('正在使用視覺模型分析圖片…', { phase: 'image_vision', path: context.path });
      const result = await analyzeVisualAssets([asset], {
        baseUrl: config.vllmVisionUrl, model: config.vllmVisionModel, apiKey: config.vllmVisionApiKey,
        registry, signal, onProgress,
        cropImage: (original, authorization, callOptions) => cropImage(original, authorization, { ...config.limits, ...callOptions }),
      });
      const bounded = boundedText(result.markdown || '', maxOutputChars);
      const warnings = [...(result.warnings || []), ...(bounded.truncated ? ['proxy_output_char_limit'] : [])];
      return { type: 'text', text: `<visual_asset source_id="${asset.sourceId}" media_type="${xmlAttribute(normalized.mediaType)}" width="${normalized.width}" height="${normalized.height}" visual_model="${xmlAttribute(config.vllmVisionModel)}" crop_count="${result.cropCount}" truncated="${bounded.truncated}">\n<analysis>\n${bounded.text}\n</analysis>${warnings.length ? `\n<warnings>${warnings.map(xmlAttribute).join(',')}</warnings>` : ''}\n</visual_asset>` };
    },
  };
}
