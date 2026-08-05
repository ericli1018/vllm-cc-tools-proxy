import path from 'node:path';

function safeBasename(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const base = path.posix.basename(normalized).slice(0, 160);
  return base && base !== '.' && base !== '/' ? base : fallback;
}

function isMediaBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.type === 'document') return block.source?.media_type === 'application/pdf';
  if (block.type === 'image') return typeof block.source?.media_type === 'string' && block.source.media_type.startsWith('image/');
  return false;
}

function pathKey(value) {
  return JSON.stringify(value || []);
}

function readToolFilenameMap(messages) {
  const result = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool_use' && typeof value.id === 'string' && String(value.name || '').toLowerCase() === 'read') {
      const filename = safeBasename(value.input?.file_path || value.input?.path || value.input?.filename || '');
      if (filename) result.set(value.id, filename);
    }
    if (Array.isArray(value.content)) walk(value.content);
  };
  walk(messages);
  return result;
}

function collectDescriptors(messages) {
  const toolFilenames = readToolFilenameMap(messages);
  const descriptors = [];
  let documentFallback = 0;
  let imageFallback = 0;

  const walkBlock = (block, currentPath, inheritedFilename = '') => {
    if (!block || typeof block !== 'object') return;
    let filename = inheritedFilename;
    if (block.type === 'tool_result') filename = toolFilenames.get(block.tool_use_id) || filename;

    if (isMediaBlock(block)) {
      const kind = block.type === 'document' ? 'document' : 'image';
      const named = safeBasename(block.source?.filename || block.title || block.name || filename);
      let resolved = named;
      if (!resolved) {
        resolved = kind === 'document'
          ? `PDF #${++documentFallback}`
          : `圖片 #${++imageFallback}`;
      }
      descriptors.push({
        path: [...currentPath],
        pathKey: pathKey(currentPath),
        kind,
        filename: resolved,
        groupKey: resolved.toLocaleLowerCase(),
      });
    }

    if (Array.isArray(block.content)) {
      for (let index = 0; index < block.content.length; index += 1) {
        walkBlock(block.content[index], [...currentPath, 'content', index], filename);
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

  const groups = new Map();
  for (const descriptor of descriptors) {
    if (!groups.has(descriptor.groupKey)) groups.set(descriptor.groupKey, []);
    groups.get(descriptor.groupKey).push(descriptor);
  }
  const groupList = [...groups.values()];
  groupList.forEach((entries, groupIndex) => {
    entries.forEach((entry, mediaIndex) => {
      entry.fileIndex = groupIndex + 1;
      entry.fileCount = groupList.length;
      entry.mediaIndex = mediaIndex + 1;
      entry.mediaCount = entries.length;
    });
  });
  return descriptors;
}

function percent(completed, total) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export class MediaProgressTracker {
  constructor(messages, { now = () => Date.now() } = {}) {
    this.now = now;
    this.descriptors = collectDescriptors(messages);
    this.byPath = new Map(this.descriptors.map((entry) => [entry.pathKey, entry]));
    this.current = null;
    this.lastStatusAt = this.now();
    this.mediaReadyAt = null;
  }

  contextForPath(pathValue) {
    return this.byPath.get(pathKey(pathValue)) || null;
  }

  #fileLabel(entry) {
    return entry.fileCount > 1
      ? `檔案 ${entry.fileIndex}/${entry.fileCount}：${entry.filename}`
      : `檔案：${entry.filename}`;
  }

  render(message, details = {}) {
    const entry = this.contextForPath(details.path) || this.current;
    this.lastStatusAt = this.now();
    if (!entry) return message;
    this.current = entry;
    const parts = [this.#fileLabel(entry)];

    if (entry.kind === 'document' && entry.mediaCount > 1) parts.push(`區段 ${entry.mediaIndex}/${entry.mediaCount}`);
    if (entry.kind === 'image') parts.push(`圖片 ${entry.mediaIndex}/${entry.mediaCount}`);

    const completed = Number.isFinite(details.completed) ? details.completed
      : Number.isFinite(details.processed_pdf_pages) ? details.processed_pdf_pages : null;
    const total = Number.isFinite(details.total) ? details.total
      : Number.isFinite(details.received_pdf_pages) ? details.received_pdf_pages : null;
    if (entry.kind === 'document' && total !== null) {
      const done = completed === null ? 0 : completed;
      const ratio = percent(done, total);
      parts.push(`頁面 ${done}/${total}${ratio === null ? '' : `（${ratio}%）`}`);
    }

    if (Number.isFinite(details.batch) && Number.isFinite(details.batches)) {
      parts.push(`批次 ${details.batch}/${details.batches}`);
    }
    parts.push(`狀態：${message}`);
    return parts.join('｜');
  }

  renderMediaReady() {
    this.mediaReadyAt = this.now();
    this.lastStatusAt = this.mediaReadyAt;
    const uniqueGroups = new Map(this.descriptors.map((entry) => [entry.groupKey, entry]));
    if (uniqueGroups.size === 1) {
      const entry = [...uniqueGroups.values()][0];
      this.current = entry;
      return `${this.#fileLabel(entry)}｜處理進度 ${this.descriptors.length}/${this.descriptors.length}（100%）｜狀態：文件與圖片內容已就緒；正在交給主模型分析…`;
    }
    if (uniqueGroups.size > 1) {
      return `檔案處理進度：${uniqueGroups.size}/${uniqueGroups.size}（100%）｜狀態：文件與圖片內容已就緒；正在交給主模型分析…`;
    }
    return '文件與圖片內容已就緒；正在交給主模型分析…';
  }

  renderHeartbeat() {
    const reference = this.mediaReadyAt ?? this.lastStatusAt;
    const seconds = Math.max(0, Math.floor((this.now() - reference) / 1000));
    if (this.mediaReadyAt !== null) {
      const prefix = this.current ? this.#fileLabel(this.current) : '目前任務';
      return `${prefix}｜狀態：主模型仍在處理中，已等待 ${seconds} 秒…`;
    }
    const prefix = this.current ? this.#fileLabel(this.current) : '目前任務';
    return `${prefix}｜狀態：目前步驟仍在處理中，已等待 ${seconds} 秒…`;
  }
}

export function createMediaProgressTracker(messages, options) {
  return new MediaProgressTracker(messages, options);
}
