import crypto from 'node:crypto';
import path from 'node:path';
import { enterRequestStructure } from '../lib/structure-guard.js';
import { parsePdfPageScope } from './pdf-page-scope.js';

const PATH_KEYS_READ = ['file_path', 'path', 'filename'];
const PATH_KEYS_SCREENSHOT = ['file_path', 'path', 'output_path', 'save_path', 'save_to', 'filename'];
const SOURCE_REFERENCE_KEYS = ['source_path', 'sourcePath', 'file_path', 'filePath', 'path', 'filename'];

export function safeMediaBasename(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const base = path.posix.basename(normalized).slice(0, 160);
  return base && base !== '.' && base !== '/' ? base : fallback;
}

export function mediaReferenceHash(value) {
  return typeof value === 'string' && value
    ? crypto.createHash('sha256').update(value).digest('hex')
    : '';
}

function trustedToolKind(name) {
  const value = String(name || '').trim().toLowerCase();
  if (value === 'read') return 'read';
  if (/^(?:screenshot|take_screenshot|capture_screenshot|browser_take_screenshot|get_screenshot)$/.test(value)) return 'screenshot';
  if (/(?:^|__)(?:browser_)?(?:take_|capture_|get_)?screenshot$/.test(value)) return 'screenshot';
  return '';
}

function looksLikeReusableScreenshotPath(value) {
  return value.startsWith('/')
    || value.startsWith('//')
    || /^[A-Za-z]:\//.test(value)
    || value.startsWith('./')
    || value.startsWith('../')
    || value.includes('/');
}

export function normalizeOriginalMediaPath(value, { kind = 'read' } = {}) {
  if (typeof value !== 'string') return '';
  let normalized = value.trim();
  if (!normalized || normalized.length > 4096) return '';
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(normalized)) return '';
  if (/^(?:data|https?|file):/i.test(normalized)) return '';
  normalized = normalized.replaceAll('\\', '/');
  if (kind === 'screenshot' && !looksLikeReusableScreenshotPath(normalized)) return '';
  const drive = /^[A-Za-z]:\//.test(normalized) ? normalized.slice(0, 2) : '';
  const unc = normalized.startsWith('//');
  if (drive) normalized = `${drive}${path.posix.normalize(normalized.slice(2))}`;
  else if (unc) normalized = `//${path.posix.normalize(normalized.slice(2)).replace(/^\/+/, '')}`;
  else normalized = path.posix.normalize(normalized);
  if (!normalized || normalized === '.') return '';
  return normalized.slice(0, 4096);
}

function pathFromInput(input, kind) {
  const keys = kind === 'screenshot' ? PATH_KEYS_SCREENSHOT : PATH_KEYS_READ;
  for (const key of keys) {
    const candidate = normalizeOriginalMediaPath(input?.[key], { kind });
    if (candidate) return candidate;
  }
  return '';
}

function pageScopeFromInput(input, originalPath) {
  if (!originalPath.toLowerCase().endsWith('.pdf') || input?.pages == null || input.pages === '') return { value: null, error: null };
  try {
    return { value: parsePdfPageScope(input.pages), error: null };
  } catch (error) {
    return { value: null, error: { code: error?.code || 'invalid_pdf_page_scope', message: String(error?.message || 'Invalid PDF page scope.') } };
  }
}

export function collectToolMediaContexts(messages) {
  const contexts = new Map();
  const ancestors = new WeakSet();
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object') return;
    const leave = enterRequestStructure(value, ancestors, depth);
    try {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (value.type === 'tool_use' && typeof value.id === 'string') {
        const toolName = String(value.name || '');
        const kind = trustedToolKind(toolName);
        const originalPath = kind ? pathFromInput(value.input, kind) : '';
        const pageScope = pageScopeFromInput(value.input, originalPath);
        const context = {
          toolName,
          toolUseId: value.id,
          kind,
          isRead: kind === 'read',
          isScreenshot: kind === 'screenshot',
          originalPath,
          filename: safeMediaBasename(originalPath),
          pageScope: pageScope.value,
          pageScopeError: pageScope.error,
          readSourceRef: originalPath ? mediaReferenceHash(originalPath) : '',
          ambiguous: false,
        };
        if (contexts.has(value.id)) {
          contexts.set(value.id, {
            ...context,
            originalPath: '', filename: '', pageScope: null, pageScopeError: null,
            readSourceRef: '', ambiguous: true,
          });
        } else contexts.set(value.id, context);
      }
      if (Array.isArray(value.content)) walk(value.content, depth + 1);
    } finally {
      leave();
    }
  };
  walk(messages);
  return contexts;
}

export function mediaSourceReference(source) {
  for (const key of SOURCE_REFERENCE_KEYS) {
    const value = source?.[key];
    if (typeof value === 'string' && value) {
      return { basename: safeMediaBasename(value), ref: mediaReferenceHash(value) };
    }
  }
  return { basename: '', ref: '' };
}

function isImageBlock(value) {
  return value?.type === 'image'
    && typeof value?.source?.type === 'string'
    && typeof value?.source?.media_type === 'string'
    && value.source.media_type.startsWith('image/');
}

function pathKey(value) {
  return JSON.stringify(value || []);
}

export function collectMediaProvenance(messages) {
  const contexts = collectToolMediaContexts(messages);
  const occurrences = [];
  let order = 0;
  const ancestors = new WeakSet();
  const walkBlock = (block, currentPath, parentType = null, inheritedContext = null, depth = 0) => {
    if (!block || typeof block !== 'object') return;
    const leave = enterRequestStructure(block, ancestors, depth);
    try {
      const context = block.type === 'tool_result'
        ? (contexts.get(block.tool_use_id) || inheritedContext)
        : inheritedContext;
      if (isImageBlock(block)) {
        const originalPath = parentType === 'tool_result' ? String(context?.originalPath || '') : '';
        const pageScope = parentType === 'tool_result' ? String(context?.pageScope?.canonical || '') : '';
        const sourceType = String(block.source?.type || '');
        occurrences.push({
          path: [...currentPath],
          pathKey: pathKey(currentPath),
          block,
          occurrenceOrder: order++,
          parentType,
          toolUseId: parentType === 'tool_result' ? String(context?.toolUseId || '') : '',
          toolName: String(context?.toolName || ''),
          toolKind: String(context?.kind || ''),
          originalPath,
          pageScope,
          pageScopeError: context?.pageScopeError || null,
          sourceType,
          mediaType: String(block.source?.media_type || ''),
          releasable: Boolean(originalPath && !context?.pageScopeError && sourceType === 'base64' && typeof block.source?.data === 'string'),
        });
      }
      if (Array.isArray(block.content)) {
        for (let index = 0; index < block.content.length; index += 1) {
          walkBlock(block.content[index], [...currentPath, 'content', index], block.type || parentType, context, depth + 1);
        }
      }
    } finally {
      leave();
    }
  };

  for (let messageIndex = 0; messageIndex < (messages || []).length; messageIndex += 1) {
    const content = messages[messageIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      walkBlock(content[blockIndex], ['messages', messageIndex, 'content', blockIndex]);
    }
  }
  return occurrences;
}
