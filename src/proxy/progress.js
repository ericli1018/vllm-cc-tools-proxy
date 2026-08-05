import crypto from 'node:crypto';
import { writeChunk } from '../lib/http.js';

export const PROGRESS_BLOCK_HEADER = '目前處理進度：';
const LEGACY_PROGRESS_BLOCK_HEADERS = Object.freeze([
  'VLLM-CC-TOOLS-PROXY 進度：',
]);
const ALL_PROGRESS_BLOCK_HEADERS = Object.freeze([
  PROGRESS_BLOCK_HEADER,
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
  return typeof text === 'string'
    && ALL_PROGRESS_BLOCK_HEADERS.some((header) => text.startsWith(`${header}\n`));
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
    heartbeatIntervalMs = 30000, drainTimeoutMs = 10000, onWrite = () => {},
  } = {}) {
    this.res = res;
    this.model = model;
    this.messageId = messageId || `msg_proxy_${crypto.randomUUID().replaceAll('-', '')}`;
    this.visibleAfterMs = visibleAfterMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.onWrite = onWrite;
    this.startedAt = Date.now();
    this.visible = false;
    this.closed = false;
    this.progressClosed = false;
    this.lastMessage = '';
    this.queue = Promise.resolve();
    this.sequence = 0;
    this.semanticHeartbeatTimer = null;
    this.pingTimer = setInterval(() => {
      this.writeRaw(event('ping', { type: 'ping' }), { kind: 'ping' }).catch(() => {});
    }, pingIntervalMs);
    this.pingTimer.unref?.();
  }

  async #write(chunk, metadata = {}) {
    const result = await writeChunk(this.res, chunk, { drainTimeoutMs: this.drainTimeoutMs });
    this.sequence += 1;
    try { await this.onWrite({ sequence: this.sequence, ...metadata, ...result }); } catch {}
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
        usage: { input_tokens: 0, output_tokens: 0 },
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

  async update(message, { force = false, kind = 'progress_delta', details = {} } = {}) {
    if (this.closed || this.progressClosed || !message || message === this.lastMessage) return;
    if (!force && !this.visible && Date.now() - this.startedAt < this.visibleAfterMs) return;
    this.lastMessage = message;
    await this.#enqueue(async () => {
      if (!this.visible) {
        this.visible = true;
        await this.#write(event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }), { kind: 'progress_block_start', phase: details.phase });
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `${PROGRESS_BLOCK_HEADER}\n${message}` },
        }), { kind, phase: details.phase });
      } else {
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `\n${message}` },
        }), { kind, phase: details.phase });
      }
    });
  }

  async closeProgress(finalMessage = '') {
    if (this.progressClosed) return;
    this.stopSemanticHeartbeat();
    if (finalMessage && this.visible) await this.update(finalMessage, { force: true, details: { phase: 'progress_close' } });
    this.progressClosed = true;
    await this.#enqueue(async () => {
      if (this.visible) {
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '\n\n' },
        }), { kind: 'progress_close_delta', phase: 'progress_close' });
        await this.#write(event('content_block_stop', { type: 'content_block_stop', index: 0 }), {
          kind: 'progress_block_stop', phase: 'progress_close',
        });
      }
    });
  }

  async stop() {
    this.closed = true;
    this.stopKeepalive();
    this.stopSemanticHeartbeat();
    await this.queue;
  }
}

export function formatSseEvent(name, data) {
  return event(name, data);
}
