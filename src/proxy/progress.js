import crypto from 'node:crypto';
import { writeChunk } from '../lib/http.js';

const INVISIBLE_SEPARATOR = '\u2063';
const MARKER_PATTERN = new RegExp(
  `${INVISIBLE_SEPARATOR}VLLMCCP:v1:([A-Za-z0-9_-]{6,128}):start${INVISIBLE_SEPARATOR}[\\s\\S]*?${INVISIBLE_SEPARATOR}VLLMCCP:v1:\\1:end${INVISIBLE_SEPARATOR}`,
  'g',
);

export function createProgressMarkers(nonce = crypto.randomBytes(12).toString('base64url')) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(nonce)) throw new Error('Invalid progress nonce');
  return {
    nonce,
    start: `${INVISIBLE_SEPARATOR}VLLMCCP:v1:${nonce}:start${INVISIBLE_SEPARATOR}`,
    end: `${INVISIBLE_SEPARATOR}VLLMCCP:v1:${nonce}:end${INVISIBLE_SEPARATOR}`,
  };
}

function stripText(text) {
  return typeof text === 'string' ? text.replace(MARKER_PATTERN, '') : text;
}

export function stripProgressHistory(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (message?.role !== 'assistant') return structuredClone(message);
    const clone = { ...message };
    if (typeof message.content === 'string') {
      clone.content = stripText(message.content);
    } else if (Array.isArray(message.content)) {
      clone.content = message.content.map((block) => {
        if (block?.type !== 'text') return structuredClone(block);
        return { ...block, text: stripText(block.text) };
      });
    }
    return clone;
  });
}

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class ProgressStream {
  constructor(res, { model = 'proxy', pingIntervalMs = 5000, visibleAfterMs = 1500, messageId } = {}) {
    this.res = res;
    this.model = model;
    this.messageId = messageId || `msg_proxy_${crypto.randomUUID().replaceAll('-', '')}`;
    this.markers = createProgressMarkers();
    this.visibleAfterMs = visibleAfterMs;
    this.startedAt = Date.now();
    this.visible = false;
    this.closed = false;
    this.progressClosed = false;
    this.lastMessage = '';
    this.queue = Promise.resolve();
    this.pingTimer = setInterval(() => {
      this.#enqueue(() => writeChunk(this.res, event('ping', { type: 'ping' }))).catch(() => {});
    }, pingIntervalMs);
    this.pingTimer.unref?.();
  }

  async open() {
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    await writeChunk(this.res, event('message_start', {
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
    }));
    await writeChunk(this.res, event('ping', { type: 'ping' }));
  }

  #enqueue(operation) {
    this.queue = this.queue.then(operation);
    return this.queue;
  }

  async update(message, { force = false } = {}) {
    if (this.closed || !message || message === this.lastMessage) return;
    if (!force && !this.visible && Date.now() - this.startedAt < this.visibleAfterMs) return;
    this.lastMessage = message;
    await this.#enqueue(async () => {
      if (!this.visible) {
        this.visible = true;
        await writeChunk(this.res, event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }));
        await writeChunk(this.res, event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `${this.markers.start}${message}` },
        }));
      } else {
        await writeChunk(this.res, event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `\n${message}` },
        }));
      }
    });
  }

  async closeProgress(finalMessage = '') {
    if (this.progressClosed) return;
    this.progressClosed = true;
    if (finalMessage) await this.update(finalMessage, { force: true });
    await this.#enqueue(async () => {
      if (this.visible) {
        await writeChunk(this.res, event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `${this.markers.end}\n\n` },
        }));
        await writeChunk(this.res, event('content_block_stop', { type: 'content_block_stop', index: 0 }));
      }
    });
  }

  async stop() {
    this.closed = true;
    clearInterval(this.pingTimer);
    await this.queue;
  }
}

export function formatSseEvent(name, data) {
  return event(name, data);
}
