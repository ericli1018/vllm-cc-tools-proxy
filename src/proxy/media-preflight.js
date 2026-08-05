import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeBase64Media } from '../lib/media.js';
import { buildMediaCacheKey } from '../cache/cache-key.js';

function isExternalBase64Media(block) {
  return block && typeof block === 'object'
    && ['document', 'image'].includes(block.type)
    && block.source?.type === 'base64'
    && typeof block.source.media_type === 'string'
    && typeof block.source.data === 'string'
    && (block.type !== 'document' || block.source.media_type === 'application/pdf')
    && (block.type !== 'image' || block.source.media_type.startsWith('image/'));
}

function extensionFor(mediaType) {
  return {
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  }[mediaType] || '.bin';
}

export async function prepareMediaHandles(messages, { maxDecodedBytes }, { signal, cacheKeyContext = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-cc-media-'));
  const allowedPaths = new Set();
  const mediaEntries = [];
  const pathByKey = new Map();
  let counter = 0;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    allowedPaths.clear();
    await fs.rm(root, { recursive: true, force: true });
  };

  const walk = async (value) => {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (Array.isArray(value)) {
      for (const item of value) await walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (isExternalBase64Media(value)) {
      const mediaType = value.source.media_type;
      const buffer = decodeBase64Media(value.source.data, maxDecodedBytes, mediaType);
      const fingerprint = buildMediaCacheKey({
        buffer,
        mediaType,
        pipelineVersion: cacheKeyContext.pipelineVersion || 'media-v3',
        visualPromptVersion: cacheKeyContext.visualPromptVersion || 'visual-v4',
        evidenceContractVersion: cacheKeyContext.evidenceContractVersion || 'evidence-v1',
        visionModel: cacheKeyContext.visionModel || '',
        visionProvider: cacheKeyContext.visionProvider || 'vllm',
        visionApiProtocol: cacheKeyContext.visionApiProtocol || 'openai-chat',
        visionThink: Boolean(cacheKeyContext.visionThink),
        resourceProfile: cacheKeyContext.resourceProfile || 'default',
      });
      let filePath = pathByKey.get(fingerprint.key);
      if (!filePath) {
        filePath = path.join(root, `media-${++counter}${extensionFor(mediaType)}`);
        await fs.writeFile(filePath, buffer, { mode: 0o600 });
        allowedPaths.add(filePath);
        pathByKey.set(fingerprint.key, filePath);
        mediaEntries.push({
          key: fingerprint.key,
          mediaSha256: fingerprint.mediaSha256,
          mediaType,
          path: filePath,
        });
      }
      value.source = {
        type: 'proxy_file',
        media_type: mediaType,
        path: filePath,
        cache_key: fingerprint.key,
        media_sha256: fingerprint.mediaSha256,
        ...(value.source.filename ? { filename: value.source.filename } : {}),
      };
      return;
    }
    if (Array.isArray(value.content)) await walk(value.content);
  };

  try {
    await walk(messages);
    return { messages, root, allowedPaths, mediaEntries, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
