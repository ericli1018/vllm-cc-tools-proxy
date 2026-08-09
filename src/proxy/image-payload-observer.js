import crypto from 'node:crypto';
import path from 'node:path';

function safeBasename(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = value.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const base = path.posix.basename(normalized).slice(0, 160);
  return base && base !== '.' && base !== '/' ? base : '';
}

function hashReference(value) {
  return typeof value === 'string' && value
    ? crypto.createHash('sha256').update(value).digest('hex')
    : '';
}

function collectToolContexts(messages) {
  const contexts = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool_use' && typeof value.id === 'string') {
      const toolName = String(value.name || '');
      const isRead = toolName.toLowerCase() === 'read';
      const sourcePath = isRead
        ? String(value.input?.file_path || value.input?.path || value.input?.filename || '')
        : '';
      contexts.set(value.id, {
        toolName,
        isRead,
        filename: safeBasename(sourcePath),
        readSourceRef: hashReference(sourcePath),
      });
    }
    if (Array.isArray(value.content)) walk(value.content);
  };
  walk(messages);
  return contexts;
}

function imageBlock(value) {
  return value?.type === 'image'
    && typeof value?.source?.type === 'string'
    && typeof value?.source?.media_type === 'string'
    && value.source.media_type.startsWith('image/');
}

function dimensionMetadata(block) {
  const output = {};
  const accept = (key, value) => {
    if (!/^(?:(?:original|resized|received)[_-]?)?(?:width|height)$/i.test(key)) return;
    if (!Number.isFinite(value) || value < 1) return;
    output[key] = value;
  };
  for (const [key, value] of Object.entries(block || {})) accept(key, value);
  for (const [key, value] of Object.entries(block?.source || {})) accept(key, value);
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function sourceReference(source) {
  for (const key of ['source_path', 'sourcePath', 'file_path', 'filePath', 'path', 'filename']) {
    const value = source?.[key];
    if (typeof value === 'string' && value) {
      return { basename: safeBasename(value), ref: hashReference(value) };
    }
  }
  return { basename: '', ref: '' };
}

export function observeImagePayloads(messages) {
  const toolContexts = collectToolContexts(messages);
  const observed = [];

  const walkBlock = (block, currentPath, parentType = null, toolContext = null) => {
    if (!block || typeof block !== 'object') return;
    const nextToolContext = block.type === 'tool_result'
      ? (toolContexts.get(block.tool_use_id) || toolContext)
      : toolContext;

    if (imageBlock(block)) {
      const origin = parentType === 'tool_result'
        ? (nextToolContext?.isRead ? 'read' : 'tool_result')
        : 'direct';
      const externalReference = sourceReference(block.source);
      observed.push({
        path: [...currentPath],
        origin,
        parentType,
        toolName: nextToolContext?.toolName || '',
        filename: nextToolContext?.filename || safeBasename(block.source?.filename || block.title || block.name || ''),
        readSourceRef: nextToolContext?.readSourceRef || '',
        sourceType: String(block.source?.type || ''),
        mediaType: String(block.source?.media_type || ''),
        blockKeys: Object.keys(block).sort(),
        sourceKeys: Object.keys(block.source || {}).sort(),
        dimensionMetadata: dimensionMetadata(block),
        sourceReferenceBasename: externalReference.basename,
        sourceReferenceRef: externalReference.ref,
      });
    }

    if (Array.isArray(block.content)) {
      for (let index = 0; index < block.content.length; index += 1) {
        walkBlock(block.content[index], [...currentPath, 'content', index], block.type || parentType, nextToolContext);
      }
    }
  };

  for (let messageIndex = 0; messageIndex < (messages || []).length; messageIndex += 1) {
    const content = messages[messageIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      walkBlock(content[blockIndex], ['messages', messageIndex, 'content', blockIndex]);
    }
  }
  return observed;
}
