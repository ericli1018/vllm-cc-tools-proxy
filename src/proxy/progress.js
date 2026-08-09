import crypto from 'node:crypto';
import { writeChunk } from '../lib/http.js';
import { normalizeAnthropicUsage } from './anthropic-usage.js';
import { allProgressBlockHeaders, progressBlockHeader } from '../i18n/response-language.js';

export const PROGRESS_BLOCK_HEADER = '目前處理進度：';
const LEGACY_PROGRESS_BLOCK_HEADERS = Object.freeze([
  'VLLM-CC-TOOLS-PROXY 進度：',
]);
const ALL_PROGRESS_BLOCK_HEADERS = Object.freeze([
  ...allProgressBlockHeaders(),
  ...LEGACY_PROGRESS_BLOCK_HEADERS,
]);

const INVISIBLE_SEPARATOR = '\u2063';
const LEGACY_NONCE = '([A-Za-z0-9_-]{6,128})';
const LEGACY_INVISIBLE_PATTERN = new RegExp(
  `${INVISIBLE_SEPARATOR}VLLMCCP:v1:${LEGACY_NONCE}:start${INVISIBLE_SEPARATOR}[\\s\\S]*?${INVISIBLE_SEPARATOR}VLLMCCP:v1:\\1:end${INVISIBLE_SEPARATOR}`,
  'g',
);
const LEGACY_PLAIN_PATTERN = new RegExp(
  `VLLMCCP:v1:${LEGACY_NONCE}:start[\\s\\S]*?VLLMCCP:v1:\\1:end`,
  'g',
);

function stripLegacyText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(LEGACY_INVISIBLE_PATTERN, '').replace(LEGACY_PLAIN_PATTERN, '');
}

function isDedicatedProgressText(text) {
  if (typeof text !== 'string') return false;
  const firstLine = text.split(/\r?\n/, 1)[0];
  return ALL_PROGRESS_BLOCK_HEADERS.some((header) => {
    if (firstLine === header) return true;
    const stem = header.replace(/[：:]$/, '');
    return firstLine.startsWith(`${stem}（`) || firstLine.startsWith(`${stem} (`);
  });
}

function isDedicatedProgressBlock(block) {
  return block?.type === 'text' && isDedicatedProgressText(block.text);
}

function textHasLegacyProgress(text) {
  if (typeof text !== 'string') return false;
  LEGACY_INVISIBLE_PATTERN.lastIndex = 0;
  LEGACY_PLAIN_PATTERN.lastIndex = 0;
  return LEGACY_INVISIBLE_PATTERN.test(text) || LEGACY_PLAIN_PATTERN.test(text);
}

export function hasProgressHistory(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (message?.role !== 'assistant') return false;
    if (typeof message.content === 'string') {
      return isDedicatedProgressText(message.content) || textHasLegacyProgress(message.content);
    }
    if (!Array.isArray(message.content)) return false;
    if (isDedicatedProgressBlock(message.content[0])) return true;
    return message.content.some((block) => block?.type === 'text' && textHasLegacyProgress(block.text));
  });
}

export function stripProgressHistory(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (message?.role !== 'assistant') return structuredClone(message);
    const clone = { ...message };
    if (typeof message.content === 'string') {
      clone.content = isDedicatedProgressText(message.content) ? '' : stripLegacyText(message.content);
      return clone;
    }
    if (!Array.isArray(message.content)) return clone;

    let blocks = message.content.map((block) => {
      if (block?.type !== 'text') return structuredClone(block);
      return { ...block, text: stripLegacyText(block.text) };
    });
    if (isDedicatedProgressBlock(blocks[0])) blocks = blocks.slice(1);
    clone.content = blocks;
    return clone;
  });
}

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class ProgressStream {
  constructor(res, {
    model = 'proxy', pingIntervalMs = 5000, visibleAfterMs = 1500, messageId,
    heartbeatIntervalMs = 30000, drainTimeoutMs = 10000, initialUsage = {}, onWrite = () => {}, onStateChange = () => {}, locale = 'zh-TW', getReceivedBytes = null,
  } = {}) {
    this.res = res;
    this.model = model;
    this.messageId = messageId || `msg_proxy_${crypto.randomUUID().replaceAll('-', '')}`;
    this.visibleAfterMs = visibleAfterMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.onWrite = onWrite;
    this.initialUsage = normalizeAnthropicUsage(initialUsage, { includeZeroCacheFields: true });
    this.authoritativeUsage = this.initialUsage;
    this.onStateChange = onStateChange;
    this.locale = locale;
    this.getReceivedBytes = typeof getReceivedBytes === 'function' ? getReceivedBytes : null;
    this.startedAt = Date.now();
    this.visible = false;
    this.closed = false;
    this.progressClosed = false;
    this.lastStateKey = '';
    this.lastHeartbeatMessage = '';
    this.revision = 0;
    this.queue = Promise.resolve();
    this.sequence = 0;
    this.semanticHeartbeatTimer = null;
    this.pendingTimer = null;
    this.pendingUpdate = null;
    this.pingTimer = setInterval(() => {
      this.writeRaw(event('ping', { type: 'ping' }), { kind: 'ping' }).catch(() => {});
    }, pingIntervalMs);
    this.pingTimer.unref?.();
  }

  async #write(chunk, metadata = {}) {
    const result = await writeChunk(this.res, chunk, { drainTimeoutMs: this.drainTimeoutMs });
    this.sequence += 1;
    const deliveryLatencyMs = Number.isFinite(metadata.changedAt)
      ? Math.max(0, Date.now() - metadata.changedAt)
      : 0;
    try { await this.onWrite({ sequence: this.sequence, ...metadata, deliveryLatencyMs, ...result }); } catch {}
    return result;
  }

  async open() {
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    await this.#write(event('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: this.initialUsage,
      },
    }), { kind: 'message_start' });
    await this.#write(event('ping', { type: 'ping' }), { kind: 'ping' });
  }

  #enqueue(operation) {
    this.queue = this.queue.then(operation);
    return this.queue;
  }

  writeRaw(chunk, metadata = {}) {
    if (this.closed) return Promise.resolve();
    return this.#enqueue(() => this.#write(chunk, { kind: 'upstream', ...metadata }));
  }

  stopKeepalive() {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  startSemanticHeartbeat(messageFactory) {
    if (this.semanticHeartbeatTimer || this.progressClosed || this.closed || typeof messageFactory !== 'function') return;
    this.semanticHeartbeatTimer = setInterval(() => {
      let message = '';
      try { message = messageFactory(); } catch { return; }
      this.update(message, {
        force: true,
        kind: 'semantic_heartbeat',
        details: { phase: 'semantic_heartbeat' },
      }).catch(() => {});
    }, this.heartbeatIntervalMs);
    this.semanticHeartbeatTimer.unref?.();
  }

  stopSemanticHeartbeat() {
    if (!this.semanticHeartbeatTimer) return;
    clearInterval(this.semanticHeartbeatTimer);
    this.semanticHeartbeatTimer = null;
  }

  #clearPending() {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingUpdate = null;
  }

  #stateKey(message, details) {
    try { return JSON.stringify([message, details || {}]); } catch { return `${message}|${String(details?.phase || '')}`; }
  }

  #schedulePending() {
    if (this.pendingTimer || !this.pendingUpdate) return;
    const remaining = Math.max(0, this.visibleAfterMs - (Date.now() - this.startedAt));
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      const pending = this.pendingUpdate;
      this.pendingUpdate = null;
      if (!pending || this.closed || this.progressClosed) return;
      this.#emitUpdate(pending).catch(() => {});
    }, remaining);
    this.pendingTimer.unref?.();
  }

  #emitUpdate(entry) {
    return this.#enqueue(async () => {
      if (this.closed || this.progressClosed) return;
      const metadata = {
        kind: entry.kind,
        phase: entry.details.phase,
        revision: entry.revision,
        changedAt: entry.changedAt,
      };
      if (!this.visible) {
        this.visible = true;
        await this.#write(event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }), { kind: 'progress_block_start', phase: entry.details.phase, revision: entry.revision, changedAt: entry.changedAt });
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `${progressBlockHeader(this.locale, { receivedBytes: this.getReceivedBytes ? this.getReceivedBytes() : undefined })}\n${entry.message}` },
        }), metadata);
      } else {
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `\n${entry.message}` },
        }), metadata);
      }
    });
  }

  usageForDelta(observed = {}) {
    const current = normalizeAnthropicUsage(this.authoritativeUsage, { includeZeroCacheFields: true });
    const next = normalizeAnthropicUsage(observed);
    return normalizeAnthropicUsage({
      input_tokens: Math.max(current.input_tokens || 0, next.input_tokens || 0),
      cache_creation_input_tokens: Math.max(current.cache_creation_input_tokens || 0, next.cache_creation_input_tokens || 0),
      cache_read_input_tokens: Math.max(current.cache_read_input_tokens || 0, next.cache_read_input_tokens || 0),
      output_tokens: next.output_tokens || 0,
      server_tool_use: next.server_tool_use || current.server_tool_use,
    }, { includeZeroCacheFields: true });
  }

  async updateUsage(usage, { phase = 'usage_update' } = {}) {
    if (this.closed) return;
    const normalized = this.usageForDelta(usage);
    this.authoritativeUsage = normalized;
    await this.writeRaw(event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: null, stop_sequence: null },
      usage: normalized,
    }), { kind: 'usage_delta', phase });
  }

  async update(message, { force = false, kind = 'progress_delta', details = {} } = {}) {
    if (this.closed || this.progressClosed || !message) return;
    const changedAt = Date.now();
    const isHeartbeat = kind === 'semantic_heartbeat';
    let revision = this.revision;

    if (isHeartbeat) {
      if (message === this.lastHeartbeatMessage) return;
      this.lastHeartbeatMessage = message;
    } else {
      const stateKey = this.#stateKey(message, details);
      if (stateKey === this.lastStateKey) return;
      this.lastStateKey = stateKey;
      revision = ++this.revision;
      try { await this.onStateChange({ revision, phase: details.phase, changedAt, message }); } catch {}
    }

    const entry = { message, kind, details, revision, changedAt };
    const belowThreshold = !this.visible && Date.now() - this.startedAt < this.visibleAfterMs;
    if (!force && belowThreshold) {
      this.pendingUpdate = entry;
      this.#schedulePending();
      return;
    }

    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingUpdate = null;
    await this.#emitUpdate(entry);
  }

  async closeProgress(finalMessage = '', { phase = 'progress_close', details = {} } = {}) {
    if (this.progressClosed) return;
    this.stopSemanticHeartbeat();
    this.#clearPending();
    const closeDetails = { ...details, phase };
    if (finalMessage && this.visible) await this.update(finalMessage, { force: true, details: closeDetails });
    this.progressClosed = true;
    await this.#enqueue(async () => {
      if (this.visible) {
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '\n\n' },
        }), { kind: 'progress_close_delta', phase });
        await this.#write(event('content_block_stop', { type: 'content_block_stop', index: 0 }), {
          kind: 'progress_block_stop', phase,
        });
      }
    });
  }

  async stop() {
    this.closed = true;
    this.stopKeepalive();
    this.stopSemanticHeartbeat();
    this.#clearPending();
    await this.queue;
  }
}

export function formatSseEvent(name, data) {
  return event(name, data);
}
