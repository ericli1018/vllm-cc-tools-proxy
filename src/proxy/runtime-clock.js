import crypto from 'node:crypto';

const LEGACY_RUNTIME_CLOCK_MARKER = '[VCC_PROXY_RUNTIME_CLOCK_V1]';
const RUNTIME_CONTEXT_MARKER = '[VCC_CONTEXT_META_V1 ';

function zonedParts(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  return Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
}

export function formatRuntimeClockReminder(now = new Date(), timeZone = 'Asia/Taipei') {
  const parts = zonedParts(now, timeZone);
  const zoneName = String(parts.timeZoneName || 'GMT+00:00');
  const offset = zoneName === 'GMT' ? '+00:00' : zoneName.replace(/^GMT/, '');
  return `[VCC_CONTEXT_META_V1 local_time=${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset} timezone=${timeZone}]`;
}

function isRuntimeMetadataText(value) {
  const text = String(value || '');
  return text.startsWith(RUNTIME_CONTEXT_MARKER) || text.includes(LEGACY_RUNTIME_CLOCK_MARKER);
}

function isToolResultOnlyUser(message) {
  return message?.role === 'user'
    && Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block?.type === 'tool_result');
}

function visibleUserIndices(messages) {
  const result = [];
  for (let index = 0; index < (Array.isArray(messages) ? messages.length : 0); index += 1) {
    const message = messages[index];
    if (message?.role !== 'user' || isToolResultOnlyUser(message)) continue;
    result.push(index);
  }
  return result;
}

function normalizedTurnContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return message?.content ?? null;
  return message.content
    .filter((block) => !(block?.type === 'text' && isRuntimeMetadataText(block.text)))
    .map((block) => {
      if (!block || typeof block !== 'object') return block;
      if (block?.source?.type === 'base64' && typeof block.source.data === 'string') {
        const digest = crypto.createHash('sha256').update(block.source.data).digest('hex');
        return { ...block, source: { ...block.source, data: `[sha256:${digest}]` } };
      }
      return block;
    });
}

function turnKey(message, messageIndex) {
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ role: message?.role || '', content: normalizedTurnContent(message) }))
    .digest('hex');
  return `${messageIndex}:${digest}`;
}

function existingRuntimeText(message) {
  if (!Array.isArray(message?.content)) return '';
  for (const block of message.content) {
    if (block?.type === 'text' && isRuntimeMetadataText(block.text)) return String(block.text);
  }
  return '';
}

function appendRuntimeText(message, text) {
  if (!text || existingRuntimeText(message)) return message;
  if (typeof message.content === 'string') {
    return { ...message, content: [{ type: 'text', text: message.content }, { type: 'text', text }] };
  }
  if (Array.isArray(message.content)) {
    return { ...message, content: [...message.content, { type: 'text', text }] };
  }
  return { ...message, content: [{ type: 'text', text }] };
}

export class RuntimeClockRegistry {
  constructor({
    maxSessions = 4096,
    maxTurnsPerSession = 256,
    ttlMs = 24 * 60 * 60 * 1000,
    clock = () => Date.now(),
  } = {}) {
    this.maxSessions = Math.max(1, Number(maxSessions) || 4096);
    this.maxTurnsPerSession = Math.max(1, Number(maxTurnsPerSession) || 256);
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 24 * 60 * 60 * 1000);
    this.clock = typeof clock === 'function' ? clock : (() => Date.now());
    this.sessions = new Map();
  }

  #prune(now = this.clock()) {
    for (const [sessionId, session] of this.sessions) {
      if (session.touchedAt + this.ttlMs <= now) this.sessions.delete(sessionId);
    }
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
  }

  #session(sessionId, create = false) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const now = this.clock();
    this.#prune(now);
    let session = this.sessions.get(id);
    if (!session && create) session = { touchedAt: now, turns: new Map() };
    if (!session) return null;
    session.touchedAt = now;
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId, key) {
    const session = this.#session(sessionId, false);
    return session?.turns?.get(key) || '';
  }

  remember(sessionId, key, metadata) {
    const id = String(sessionId || '').trim();
    const value = String(metadata || '');
    if (!id || !key || !value) return value;
    const session = this.#session(id, true);
    if (session.turns.has(key)) return session.turns.get(key);
    session.turns.set(key, value);
    while (session.turns.size > this.maxTurnsPerSession) session.turns.delete(session.turns.keys().next().value);
    return value;
  }

  getOrCreate(sessionId, key, { now, timeZone = 'Asia/Taipei' } = {}) {
    const existing = this.get(sessionId, key);
    if (existing) return existing;
    const instant = now instanceof Date ? now : new Date(now ?? this.clock());
    return this.remember(sessionId, key, formatRuntimeClockReminder(instant, timeZone));
  }
}

export function injectRuntimeClockReminder(request, {
  enabled = true,
  timeZone = 'Asia/Taipei',
  now,
  sessionId = '',
  continuation = false,
  registry = null,
} = {}) {
  if (!enabled || !request || typeof request !== 'object' || !Array.isArray(request.messages)) return request;
  const messages = structuredClone(request.messages);
  const userIndices = visibleUserIndices(messages);
  if (userIndices.length === 0) return request;

  // First restore every previously known turn at its original location. This makes
  // the prompt prefix immutable across later Claude Code requests even though the
  // client never echoes Proxy-only metadata back to us.
  if (registry && sessionId) {
    for (const index of userIndices) {
      const key = turnKey(messages[index], index);
      const embedded = existingRuntimeText(messages[index]);
      if (embedded && embedded.startsWith(RUNTIME_CONTEXT_MARKER)) registry.remember(sessionId, key, embedded);
      const remembered = registry.get(sessionId, key);
      if (remembered && !embedded) messages[index] = appendRuntimeText(messages[index], remembered);
    }
  }

  const currentIndex = userIndices.at(-1);
  const current = messages[currentIndex];
  if (existingRuntimeText(current)) return { ...request, messages };

  // A tool_result continuation belongs to the existing user interaction. If the
  // Proxy has no matching in-memory state (for example after restart), do not
  // invent a new historical time because that would change the cached prefix.
  if (continuation) return { ...request, messages };

  const key = turnKey(current, currentIndex);
  let metadata;
  if (registry && sessionId) {
    metadata = registry.getOrCreate(sessionId, key, { now, timeZone });
  } else {
    const instant = now instanceof Date ? now : new Date(now ?? Date.now());
    metadata = formatRuntimeClockReminder(instant, timeZone);
  }
  messages[currentIndex] = appendRuntimeText(current, metadata);
  return { ...request, messages };
}

export { LEGACY_RUNTIME_CLOCK_MARKER as RUNTIME_CLOCK_MARKER, RUNTIME_CONTEXT_MARKER };
