import crypto from 'node:crypto';
import { decodeBase64Media } from '../lib/media.js';
import { enterRequestStructure } from '../lib/structure-guard.js';
import { collectMediaProvenance } from './media-provenance.js';

const ID_VERSION = 'vcc-media-history-v1';

function stableMediaId({ originalPath, pageScope, mediaType, mediaSha256 }) {
  const input = [ID_VERSION, originalPath, pageScope || '', mediaType, mediaSha256].join('\0');
  return `m_${crypto.createHash('sha256').update(input).digest('hex').slice(0, 32)}`;
}

function marker(mediaId, originalPath) {
  return `[Image released: media_id=${mediaId}; path=${originalPath}]`;
}

function cloneWithReplacements(value, currentPath, replacements, ancestors, depth = 0) {
  if (!value || typeof value !== 'object') return value;
  const key = JSON.stringify(currentPath);
  if (replacements.has(key)) return { type: 'text', text: replacements.get(key) };
  const leave = enterRequestStructure(value, ancestors, depth);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneWithReplacements(item, [...currentPath, index], replacements, ancestors, depth + 1));
    }
    const output = {};
    for (const [name, item] of Object.entries(value)) {
      output[name] = cloneWithReplacements(item, [...currentPath, name], replacements, ancestors, depth + 1);
    }
    return output;
  } finally {
    leave();
  }
}

export function normalizeMediaHistory(messages, {
  enabled = false,
  maxPathImages = 4,
  maxDecodedBytes = 64 * 1024 * 1024,
} = {}) {
  if (!enabled) {
    return {
      messages,
      changed: false,
      summary: { totalImages: 0, pathBackedImages: 0, pathlessImages: 0, retainedPathImages: 0, releasedPathImages: 0, releasedDecodedBytes: 0 },
    };
  }
  if (!Number.isInteger(maxPathImages) || maxPathImages < 0) throw new TypeError('maxPathImages must be a nonnegative integer');
  const occurrences = collectMediaProvenance(messages);
  const releasable = occurrences.filter(entry => entry.releasable);
  const retained = new Set(releasable.slice(Math.max(0, releasable.length - maxPathImages)).map(entry => entry.pathKey));
  const replacements = new Map();
  let releasedDecodedBytes = 0;
  for (const entry of releasable) {
    if (retained.has(entry.pathKey)) continue;
    const buffer = decodeBase64Media(entry.block.source.data, maxDecodedBytes, entry.mediaType);
    const mediaSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const mediaId = stableMediaId({ ...entry, mediaSha256 });
    replacements.set(entry.pathKey, marker(mediaId, entry.originalPath));
    releasedDecodedBytes += buffer.length;
  }
  const pathBackedImages = occurrences.filter(entry => Boolean(entry.originalPath)).length;
  const releasedPathImages = replacements.size;
  const summary = {
    totalImages: occurrences.length,
    pathBackedImages,
    pathlessImages: occurrences.length - pathBackedImages,
    retainedPathImages: pathBackedImages - releasedPathImages,
    releasedPathImages,
    releasedDecodedBytes,
  };
  if (!releasedPathImages) return { messages, changed: false, summary };
  return {
    messages: cloneWithReplacements(messages, ['messages'], replacements, new WeakSet()),
    changed: true,
    summary,
  };
}
