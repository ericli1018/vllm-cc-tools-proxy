import crypto from 'node:crypto';
import { writeChunk } from '../lib/http.js';
import { normalizeAnthropicUsage } from './anthropic-usage.js';
import { allProgressBlockHeaders, modelTimelineHeader, progressBlockHeader, statusText } from '../i18n/response-language.js';

export const PROGRESS_BLOCK_HEADER = '模型處理中';
const LEGACY_PROGRESS_BLOCK_HEADERS = Object.freeze([
  '目前處理進度：',
  '当前处理进度：',
  'Current progress:',
  '現在の処理状況：',
  '현재 처리 상태:',
  'VLLM-CC-TOOLS-PROXY 進度：',
]);
const STARTUP_BANNER_PREFIX = '╭─◆ CC TOOL PROXY ';
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

function isProgressHeaderLine(line) {
  return ALL_PROGRESS_BLOCK_HEADERS.some((header) => {
    if (line === header) return true;
    if (line.startsWith(`${header} · `)) return true;
    const stem = header.replace(/[：:]$/, '');
    return line.startsWith(`${stem}（`) || line.startsWith(`${stem} (`);
  });
}

function isDedicatedProgressText(text) {
  if (typeof text !== 'string') return false;
  const lines = text.split(/\r?\n/, 3);
  const firstLine = lines[0] || '';
  if (firstLine.startsWith(STARTUP_BANNER_PREFIX)) return true;
  if (isProgressHeaderLine(firstLine)) return true;
  return Boolean(firstLine && lines[1] && isProgressHeaderLine(lines[1]));
}

function progressBlockText(block) {
  if (block?.type === 'text') return block.text;
  if (block?.type === 'thinking') return block.thinking;
  return '';
}

function isDedicatedProgressBlock(block) {
  return ['text', 'thinking'].includes(block?.type) && isDedicatedProgressText(progressBlockText(block));
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
    if (message?.role !== 'assistant') return message;
    const clone = { ...message };
    if (typeof message.content === 'string') {
      clone.content = isDedicatedProgressText(message.content) ? '' : stripLegacyText(message.content);
      return clone;
    }
    if (!Array.isArray(message.content)) return clone;

    let blocks = message.content.map((block) => {
      if (block?.type !== 'text') return block;
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
    heartbeatIntervalMs = 30000, drainTimeoutMs = 10000, initialUsage = {}, onWrite = () => {}, onStateChange = () => {}, locale = 'zh-TW', getReceivedBytes = null, carrier = 'text', visibleProgressEnabled = true,
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
    this.carrier = carrier === 'thinking' ? 'thinking' : 'text';
    this.visibleProgressEnabled = visibleProgressEnabled !== false;
    this.startedAt = Date.now();
    this.progressHeader = progressBlockHeader(this.locale, { timestampMs: this.startedAt });
    this.timelineHeader = '';
    this.modelTimeline = {
      active: false,
      startedAt: 0,
      phase: 'waiting',
      round: 0,
      content: '',
      rendered: false,
      heartbeatRun: 0,
    };
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
    this.pendingUpdates = [];
    this.pendingRelease = null;
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

  async showStartupBanner(text) {
    if (!this.visibleProgressEnabled || this.closed || this.progressClosed || this.visible || !text) return false;
    this.#clearPending();
    const changedAt = Date.now();
    const revision = ++this.revision;
    this.lastStateKey = this.#stateKey(text, { phase: 'startup_banner' });
    try { await this.onStateChange({ revision, phase: 'startup_banner', changedAt, message: text }); } catch {}
    await this.#enqueue(async () => {
      if (this.closed || this.progressClosed || this.visible) return;
      this.visible = true;
      await this.#write(event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }), { kind: 'progress_block_start', phase: 'startup_banner', revision, changedAt });
      await this.#write(event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: String(text) },
      }), { kind: 'startup_banner', phase: 'startup_banner', revision, changedAt });
      await this.#write(event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '\n' },
      }), { kind: 'startup_banner_newline', phase: 'startup_banner', revision, changedAt });
    });
    return true;
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
    if (!this.visibleProgressEnabled || this.semanticHeartbeatTimer || this.progressClosed || this.closed || typeof messageFactory !== 'function') return;
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
    this.pendingUpdates.length = 0;
  }

  #stateKey(message, details) {
    try { return JSON.stringify([message, details || {}]); } catch { return `${message}|${String(details?.phase || '')}`; }
  }

  #schedulePending() {
    if (this.pendingTimer || this.pendingUpdates.length === 0) return;
    const remaining = Math.max(0, this.visibleAfterMs - (Date.now() - this.startedAt));
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      if (this.closed || this.progressClosed) return;
      this.#flushPending().catch(() => {});
    }, remaining);
    this.pendingTimer.unref?.();
  }

  async #flushPending() {
    if (this.pendingRelease) return this.pendingRelease;
    if (this.pendingUpdates.length === 0 || this.closed || this.progressClosed) return;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    const entries = this.pendingUpdates.splice(0);
    this.pendingUpdate = null;
    this.pendingRelease = (async () => {
      for (const entry of entries) await this.#emitUpdate(entry);
    })();
    try {
      await this.pendingRelease;
    } finally {
      this.pendingRelease = null;
    }
  }

  #modelTimelineGlyph(phase) {
    if (phase === 'thinking') return '◐';
    if (phase === 'response') return '◆';
    if (phase === 'tool') return '◇';
    return '○';
  }

  #modelTimelineElapsedSeconds(details = {}, changedAt = Date.now()) {
    const explicit = Number(details.timeline_elapsed_ms);
    const elapsedMs = Number.isFinite(explicit)
      ? Math.max(0, explicit)
      : Math.max(0, changedAt - (this.modelTimeline.startedAt || changedAt));
    return Math.floor(elapsedMs / 1000);
  }

  #modelTimelineSnapshot() {
    return `${this.timelineHeader}${this.modelTimeline.content}`;
  }

  #appendModelTimeline(fragment, { resetHeartbeat = true } = {}) {
    const value = String(fragment || '');
    if (!value) return '';
    this.modelTimeline.content += value;
    if (resetHeartbeat) this.modelTimeline.heartbeatRun = 0;
    return value;
  }

  #prepareModelTimeline(kind, details = {}, changedAt = Date.now(), message = '') {
    const phase = String(details.phase || '');
    const round = Math.max(0, Math.trunc(Number(details.round) || 0));
    const timelineEnabled = details.model_timeline === true;
    const isStart = timelineEnabled && ['managed_model_round_start', 'base_request_start'].includes(phase);
    const isPhase = timelineEnabled && phase === 'model_stream_phase' && ['thinking', 'response', 'tool'].includes(String(details.model_phase || ''));
    const isFirstSemantic = timelineEnabled && phase === 'model_semantic_first_delta';
    const isBusyWait = timelineEnabled && phase === 'upstream_busy_wait';
    const isTerminal = ['handoff_to_claude_code', 'returning_visible_response', 'returning_model_output'].includes(phase);
    const isHeartbeat = kind === 'semantic_heartbeat';

    if (!this.modelTimeline.active && !(isStart || isPhase || isFirstSemantic || isBusyWait)) return null;

    let emit = false;
    let append = '';
    let terminal = false;

    if (!this.modelTimeline.active) {
      const startedAt = Number(details.model_started_at);
      this.modelTimeline.active = true;
      this.modelTimeline.startedAt = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : changedAt;
      this.timelineHeader = modelTimelineHeader(this.locale, { timestampMs: this.modelTimeline.startedAt });
      this.modelTimeline.phase = 'waiting';
      this.modelTimeline.round = round;
      this.modelTimeline.content = ' ○';
      this.modelTimeline.heartbeatRun = 0;
    } else if (isStart) {
      const elapsed = this.#modelTimelineElapsedSeconds(details, changedAt);
      append += this.#appendModelTimeline(` ${elapsed}s ○`);
      this.modelTimeline.phase = 'waiting';
      if (round > 0) this.modelTimeline.round = round;
      emit = true;
    }

    if (isBusyWait) {
      append += this.#appendModelTimeline(' ↻');
      emit = true;
    } else if (isPhase) {
      const nextPhase = String(details.model_phase);
      if (this.modelTimeline.phase !== nextPhase) {
        const elapsed = this.#modelTimelineElapsedSeconds(details, changedAt);
        append += this.#appendModelTimeline(` ${elapsed}s ${this.#modelTimelineGlyph(nextPhase)}`);
        this.modelTimeline.phase = nextPhase;
        emit = true;
      }
    } else if (isHeartbeat && this.modelTimeline.active) {
      const warning = String(message || '').trim().startsWith('⚠');
      const bar = this.modelTimeline.heartbeatRun > 0 ? '|' : ' |';
      append += this.#appendModelTimeline(`${bar}${warning ? ' ⚠' : ''}`, { resetHeartbeat: false });
      this.modelTimeline.heartbeatRun = warning ? 0 : this.modelTimeline.heartbeatRun + 1;
      emit = true;
    } else if (isTerminal && this.modelTimeline.active) {
      const elapsed = this.#modelTimelineElapsedSeconds(details, changedAt);
      append += this.#appendModelTimeline(` ${elapsed}s`);
      emit = true;
      terminal = true;
    }

    const snapshot = this.#modelTimelineSnapshot();
    return { active: true, emit, append, snapshot, fullText: snapshot, terminal };
  }

  #emitUpdate(entry) {
    return this.#enqueue(async () => {
      if (this.closed || this.progressClosed) return;
      const metadata = {
        kind: entry.kind,
        phase: entry.details.phase,
        revision: entry.revision,
        changedAt: entry.changedAt,
        renderMode: 'append',
      };
      const message = String(entry.message);
      const timeline = entry.timeline || null;
      const thinkingCarrier = this.carrier === 'thinking';
      if (timeline?.active && !timeline.emit) return;

      if (!this.visible) {
        this.visible = true;
        await this.#write(event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: thinkingCarrier
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' },
        }), { kind: 'progress_block_start', phase: entry.details.phase, revision: entry.revision, changedAt: entry.changedAt, carrier: this.carrier });
        const initialText = timeline?.active ? timeline.snapshot : `${this.progressHeader}\n${message}`;
        if (timeline?.active) this.modelTimeline.rendered = true;
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: thinkingCarrier
            ? { type: 'thinking_delta', thinking: initialText }
            : { type: 'text_delta', text: initialText },
        }), { ...metadata, renderMode: timeline?.active ? 'timeline_inline' : metadata.renderMode, carrier: this.carrier });
      } else {
        let deltaText = `\n${message}`;
        let timelineRenderMode = metadata.renderMode;
        if (timeline?.active) {
          if (!this.modelTimeline.rendered) {
            deltaText = `\n${timeline.snapshot}`;
            this.modelTimeline.rendered = true;
          } else {
            deltaText = timeline.append;
          }
          timelineRenderMode = 'timeline_inline';
        }
        if (!deltaText) return;
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: thinkingCarrier
            ? { type: 'thinking_delta', thinking: deltaText }
            : { type: 'text_delta', text: deltaText },
        }), { ...metadata, renderMode: timelineRenderMode, carrier: this.carrier });
      }
    });
  }

  usageForDelta(observed = {}) {
    const current = normalizeAnthropicUsage(this.authoritativeUsage, { includeZeroCacheFields: true });
    const source = observed && typeof observed === 'object' && !Array.isArray(observed) ? observed : {};
    const hasValidCounter = (field) => Number.isInteger(source[field]) && source[field] >= 0;
    const hasInputUsage = [
      'input_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ].some(hasValidCounter);
    const next = normalizeAnthropicUsage(source, { includeZeroCacheFields: true });
    const inputUsage = hasInputUsage ? next : current;
    return normalizeAnthropicUsage({
      input_tokens: inputUsage.input_tokens || 0,
      cache_creation_input_tokens: inputUsage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: inputUsage.cache_read_input_tokens || 0,
      output_tokens: hasValidCounter('output_tokens') ? next.output_tokens : (current.output_tokens || 0),
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

  async update(message, { force = false, kind = 'progress_delta', details = {}, renderMode = 'auto' } = {}) {
    if (!this.visibleProgressEnabled || this.closed || this.progressClosed || !message) return;
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

    const timeline = this.#prepareModelTimeline(kind, details, changedAt, message);
    if (timeline?.terminal && message) {
      let terminalMessage = message;
      if (String(details.phase || '') === 'handoff_to_claude_code') {
        const toolNames = Array.isArray(details.tool_names) ? details.tool_names.filter(Boolean) : [];
        terminalMessage = toolNames.length === 1
          ? statusText(this.locale, 'timelineHandoffSingle', { tool: toolNames[0] })
          : statusText(this.locale, 'timelineHandoffMultiple');
      }
      const terminalFragment = ` ${terminalMessage}`;
      this.modelTimeline.content += terminalFragment;
      timeline.append += terminalFragment;
      timeline.snapshot += terminalFragment;
      timeline.fullText = timeline.snapshot;
    }
    const entry = { message, kind, details, revision, changedAt, renderMode, timeline };
    const belowThreshold = Date.now() - this.startedAt < this.visibleAfterMs;
    if (belowThreshold) {
      this.pendingUpdates.push(entry);
      this.pendingUpdate = entry;
      this.#schedulePending();
      return;
    }

    await this.#flushPending();
    await this.#emitUpdate(entry);
  }

  async closeProgress(finalMessage = '', { phase = 'progress_close', details = {} } = {}) {
    if (this.progressClosed) return;
    this.stopSemanticHeartbeat();
    this.#clearPending();
    const closeDetails = { ...details, phase };
    if (finalMessage && (this.visible || this.modelTimeline.active)) await this.update(finalMessage, { force: true, details: closeDetails });
    this.progressClosed = true;
    await this.#enqueue(async () => {
      if (this.visible) {
        await this.#write(event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: this.carrier === 'thinking'
            ? { type: 'thinking_delta', thinking: '\n\n' }
            : { type: 'text_delta', text: '\n\n' },
        }), { kind: 'progress_close_delta', phase, carrier: this.carrier });
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
    try { await this.queue; } catch {}
  }

  async dispose() {
    if (!this.res && !this.pingTimer && !this.semanticHeartbeatTimer && !this.pendingTimer && !this.pendingUpdate && this.pendingUpdates.length === 0 && !this.pendingRelease) return;
    await this.stop();
    this.res = null;
    this.getReceivedBytes = null;
    this.onWrite = () => {};
    this.onStateChange = () => {};
  }
}

export function formatSseEvent(name, data) {
  return event(name, data);
}
