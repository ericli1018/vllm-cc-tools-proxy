import crypto from 'node:crypto';
import path from 'node:path';
import { parsePdfPageScope } from './pdf-page-scope.js';
import { languageProfile, mediaText, mediaTimelineLabels, statusText } from '../i18n/response-language.js';
import { enterRequestStructure } from '../lib/structure-guard.js';

function safeBasename(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.replaceAll('\\', '/').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
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

function readToolContextMap(messages) {
  const result = new Map();
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
        const isRead = toolName.toLowerCase() === 'read';
        const rawPath = isRead ? (value.input?.file_path || value.input?.path || value.input?.filename || '') : '';
        const filename = safeBasename(rawPath);
        let pageScope = null;
        let pageScopeError = null;
        if (isRead) {
          try { pageScope = parsePdfPageScope(value.input?.pages); }
          catch (error) { pageScopeError = { code: error?.code || 'invalid_pdf_page_scope', message: String(error?.message || 'Invalid PDF page scope.') }; }
        }
        result.set(value.id, {
          toolName, isRead, filename, pageScope, pageScopeError,
          readSourceRef: rawPath ? crypto.createHash('sha256').update(String(rawPath)).digest('hex') : '',
        });
      }
      if (Array.isArray(value.content)) walk(value.content, depth + 1);
    } finally {
      leave();
    }
  };
  walk(messages);
  return result;
}

function collectDescriptors(messages, locale = 'zh-TW', { excludePaths = new Set() } = {}) {
  const toolContexts = readToolContextMap(messages);
  const descriptors = [];
  let documentFallback = 0;
  let imageFallback = 0;

  const ancestors = new WeakSet();
  const walkBlock = (block, currentPath, inheritedFilename = '', inheritedToolContext = null, depth = 0) => {
    if (!block || typeof block !== 'object') return;
    const leave = enterRequestStructure(block, ancestors, depth);
    try {
    let filename = inheritedFilename;
    const toolContext = block.type === 'tool_result' ? (toolContexts.get(block.tool_use_id) || inheritedToolContext) : inheritedToolContext;
    if (toolContext?.filename) filename = toolContext.filename;

    if (isMediaBlock(block) && !excludePaths.has(pathKey(currentPath))) {
      const kind = block.type === 'document' ? 'document' : 'image';
      const named = safeBasename(block.source?.filename || block.title || block.name || filename);
      let resolved = named;
      if (!resolved) {
        resolved = kind === 'document'
          ? `PDF #${++documentFallback}`
          : mediaText(locale, 'imageFallback', { index: ++imageFallback });
      }
      const origin = toolContext ? (toolContext.isRead ? 'read' : 'tool_result') : 'direct';
      const originTool = toolContext?.toolName || '';
      const sourceKind = kind === 'document'
        ? 'pdf_document'
        : origin === 'read'
          ? (String(toolContext?.filename || '').toLowerCase().endsWith('.pdf') ? 'read_pdf_image' : 'read_image')
          : origin === 'tool_result' ? 'tool_result_image' : 'direct_image';
      descriptors.push({
        path: [...currentPath],
        pathKey: pathKey(currentPath),
        kind,
        filename: resolved,
        groupKey: resolved.toLocaleLowerCase(),
        origin, originTool, sourceKind,
        ...(toolContext?.pageScope ? { pageScope: toolContext.pageScope } : {}),
        ...(kind === 'document' && toolContext?.pageScopeError ? { pageScopeError: toolContext.pageScopeError } : {}),
        ...(toolContext?.readSourceRef ? { readSourceRef: toolContext.readSourceRef } : {}),
      });
    }

    if (Array.isArray(block.content)) {
      for (let index = 0; index < block.content.length; index += 1) {
        walkBlock(block.content[index], [...currentPath, 'content', index], filename, toolContext, depth + 1);
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


const MEDIA_TIMELINE_STAGES = Object.freeze({
  media_cache_miss: 'preparing', media_ready: 'ready',
  pdf_start: 'parsing', pdf_metadata: 'extracting', pdf_classify: 'classifying',
  pdf_document_map_start: 'mapping', pdf_document_map: 'mapping',
  pdf_visual_prepare: 'rendering', pdf_visual_plan: 'planning', pdf_visual_batch: 'analyzing',
  pdf_visual_progress: 'analyzing', pdf_complete: 'merging',
  pdf_schematic_overview: 'rendering', pdf_schematic_merge: 'merging',
  image_start: 'preparing', image_vision: 'analyzing', image_complete: 'complete',
  image_vision_unavailable: 'failed', vision_crop: 'cropping', vision_needs_zoom: 'zooming',
  vision_crop_rejected: 'rejected', vision_crop_budget_exhausted: 'limited', vision_quality_retry: 'retrying',
  directed_visual_registered: 'preparing', directed_perception_planning: 'planning',
  directed_perception_wait: 'waiting', directed_perception_started: 'analyzing',
  directed_perception_completed: 'complete', directed_perception_failed: 'failed',
  directed_perception_planning_failed: 'failed',
});

function mediaStage(details) {
  const phase = String(details.phase || '');
  if (!/^(?:media_|pdf_|image_|vision_|directed_(?:visual|perception)_)/.test(phase)) return '';
  if (phase === 'directed_perception_completed' && ['partial', 'unreadable'].includes(details.status)) return details.status;
  if (MEDIA_TIMELINE_STAGES[phase]) return MEDIA_TIMELINE_STAGES[phase];
  if (phase.endsWith('_failed')) return 'failed';
  if (phase.endsWith('_budget_exhausted')) return 'limited';
  if (phase.endsWith('_tile_render')) return 'rendering';
  if (phase.endsWith('_tile_analyze')) return 'analyzing';
  if (phase.endsWith('_tile')) return 'zooming';
  return 'processing';
}

function progressCounter(value) { return Number.isInteger(value) && value >= 0 ? value : null; }

export class MediaProgressTracker {
  constructor(messages, { now = () => Date.now(), locale = 'zh-TW', excludePaths = new Set() } = {}) {
    this.now = now;
    this.locale = locale;
    this.profile = languageProfile(locale);
    this.descriptors = collectDescriptors(messages, locale, { excludePaths });
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
      ? mediaText(this.locale, 'fileMultiple', { index: entry.fileIndex, count: entry.fileCount, filename: entry.filename })
      : mediaText(this.locale, 'fileSingle', { filename: entry.filename });
  }

  // Keep full sentences in diagnostic render(); the visible SSE uses these bounded fields.
  timelineDetails(details = {}) {
    const stage = mediaStage(details);
    if (!stage) return details;
    const phase = String(details.phase);
    const labels = mediaTimelineLabels(this.locale);
    const global = ['media_cache_miss', 'media_ready'].includes(phase);
    const entry = global ? null : (details.path ? this.contextForPath(details.path) : this.current);
    const context = [];
    if (entry) {
      this.current = entry;
      context.push(this.#fileLabel(entry));
      if (entry.kind === 'image') {
        context.push(`${entry.sourceKind === 'read_pdf_image' ? labels.pdfImage : labels.image} ${entry.mediaIndex}/${entry.mediaCount}`);
        // Only assign absolute pages when the explicit scope and returned images agree.
        if (entry.sourceKind === 'read_pdf_image' && entry.pageScope?.pages?.length === entry.mediaCount) {
          context.push(`${labels.page} ${entry.pageScope.pages[entry.mediaIndex - 1]}`);
        }
      } else {
        if (entry.mediaCount > 1) context.push(`${labels.segment} ${entry.mediaIndex}/${entry.mediaCount}`);
        if (entry.pageScope?.canonical) context.push(`${labels.page} ${entry.pageScope.canonical}`);
      }
    }
    const parts = [labels[stage]];
    const isTile = /_(?:zoom|schematic)_tile/.test(phase) || phase === 'image_zoom_budget_exhausted';
    const completed = progressCounter(details.completed ?? details.processed_pdf_pages);
    const total = progressCounter(details.total ?? details.received_pdf_pages);
    const page = progressCounter(details.page);
    if (page !== null && page > 0) parts.push(`${labels.page} ${page}`);
    if (isTile) {
      const tile = progressCounter(details.tile) ?? completed;
      if (tile !== null) parts.push(`${labels.tile} ${tile}${total > 0 ? `/${total}` : ''}`);
    } else if (phase.startsWith('pdf_') && total > 0) {
      const kind = phase === 'pdf_document_map' ? labels.sample : labels.page;
      parts.push(`${kind} ${completed !== null ? `${completed}/` : ''}${total}`);
    }
    if (progressCounter(details.batch) !== null && details.batch > 0 && progressCounter(details.batches) !== null && details.batches > 0) {
      parts.push(`${labels.batch} ${details.batch}/${details.batches}`);
    }
    if (phase === 'vision_quality_retry' && progressCounter(details.attempt) !== null) parts.push(String(details.attempt));
    const mediaContext = context.join(' · ');
    const label = parts.join(' · ');
    return {
      ...details,
      media_timeline: true,
      media_context: mediaContext,
      media_label: label,
      media_key: JSON.stringify([entry?.pathKey || '', phase, mediaContext, label, details.status || '']),
      media_warning: ['partial', 'unreadable', 'failed', 'limited', 'rejected'].includes(stage),
    };
  }

  render(message, details = {}) {
    const entry = this.contextForPath(details.path) || this.current;
    this.lastStatusAt = this.now();
    if (!entry) return message;
    this.current = entry;
    const parts = [this.#fileLabel(entry)];

    if (entry.kind === 'document' && entry.mediaCount > 1) parts.push(mediaText(this.locale, 'segment', { index: entry.mediaIndex, count: entry.mediaCount }));
    if (entry.kind === 'image') parts.push(mediaText(this.locale, 'imagePart', { index: entry.mediaIndex, count: entry.mediaCount }));

    const completed = Number.isFinite(details.completed) ? details.completed
      : Number.isFinite(details.processed_pdf_pages) ? details.processed_pdf_pages : null;
    const total = Number.isFinite(details.total) ? details.total
      : Number.isFinite(details.received_pdf_pages) ? details.received_pdf_pages : null;
    if (entry.kind === 'document' && total !== null) {
      const done = completed === null ? 0 : completed;
      const ratio = percent(done, total);
      parts.push(mediaText(this.locale, 'page', { done, total, percent: ratio }));
    }

    if (Number.isFinite(details.batch) && Number.isFinite(details.batches)) {
      parts.push(mediaText(this.locale, 'batch', { index: details.batch, count: details.batches }));
    }
    parts.push(mediaText(this.locale, 'status', { message }));
    return parts.join(this.profile.media.separator);
  }

  renderMediaReady() {
    this.mediaReadyAt = this.now();
    this.lastStatusAt = this.mediaReadyAt;
    const uniqueGroups = new Map(this.descriptors.map((entry) => [entry.groupKey, entry]));
    if (uniqueGroups.size === 1) {
      const entry = [...uniqueGroups.values()][0];
      this.current = entry;
      return [this.#fileLabel(entry), mediaText(this.locale, 'progress', { done: this.descriptors.length, total: this.descriptors.length }), mediaText(this.locale, 'status', { message: statusText(this.locale, 'mediaReady') })].join(this.profile.media.separator);
    }
    if (uniqueGroups.size > 1) {
      return [mediaText(this.locale, 'filesProgress', { done: uniqueGroups.size, total: uniqueGroups.size }), mediaText(this.locale, 'status', { message: statusText(this.locale, 'mediaReady') })].join(this.profile.media.separator);
    }
    return statusText(this.locale, 'mediaReady');
  }

  renderHeartbeat({ receivedBytes } = {}) {
    const reference = this.mediaReadyAt ?? this.lastStatusAt;
    const seconds = Math.max(0, Math.floor((this.now() - reference) / 1000));
    if (this.mediaReadyAt !== null) {
      const prefix = this.current ? this.#fileLabel(this.current) : mediaText(this.locale, 'currentTask');
      return [prefix, mediaText(this.locale, 'status', { message: statusText(this.locale, 'modelWaiting', { seconds, receivedBytes }) })].join(this.profile.media.separator);
    }
    const prefix = this.current ? this.#fileLabel(this.current) : mediaText(this.locale, 'currentTask');
    return [prefix, mediaText(this.locale, 'status', { message: statusText(this.locale, 'currentStepWaiting', { seconds }) })].join(this.profile.media.separator);
  }
}

export function createMediaProgressTracker(messages, options) {
  return new MediaProgressTracker(messages, options);
}
