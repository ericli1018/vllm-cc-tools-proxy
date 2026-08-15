const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 64;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_SESSION = 16 * 1024 * 1024;

function boundedPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

function stringBytes(value) {
  return String(value).length * 2;
}

function estimateValueBytes(root) {
  const stack = [root];
  const seen = new WeakSet();
  let bytes = 0;

  while (stack.length > 0) {
    const value = stack.pop();
    if (value == null) {
      bytes += 8;
      continue;
    }

    const type = typeof value;
    if (type === 'string') {
      bytes += 16 + stringBytes(value);
      continue;
    }
    if (type === 'number' || type === 'bigint') {
      bytes += 16;
      continue;
    }
    if (type === 'boolean') {
      bytes += 8;
      continue;
    }
    if (type !== 'object') {
      bytes += 8;
      continue;
    }

    if (seen.has(value)) continue;
    seen.add(value);

    if (ArrayBuffer.isView(value)) {
      bytes += 32 + Number(value.byteLength || 0);
      continue;
    }
    if (value instanceof ArrayBuffer) {
      bytes += 32 + value.byteLength;
      continue;
    }

    bytes += 32;
    if (Array.isArray(value)) {
      bytes += value.length * 8;
      for (const item of value) stack.push(item);
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      bytes += 16 + stringBytes(key);
      stack.push(child);
    }
  }

  return Math.max(1, bytes);
}

export class MediaContinuationCache {
  constructor({
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxEntriesPerSession = DEFAULT_MAX_ENTRIES_PER_SESSION,
    retentionMs = DEFAULT_RETENTION_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxBytesPerSession = DEFAULT_MAX_BYTES_PER_SESSION,
    clock = () => Date.now(),
  } = {}) {
    this.maxSessions = boundedPositiveInteger(maxSessions, DEFAULT_MAX_SESSIONS);
    this.maxEntriesPerSession = boundedPositiveInteger(maxEntriesPerSession, DEFAULT_MAX_ENTRIES_PER_SESSION);
    this.retentionMs = boundedPositiveInteger(retentionMs, DEFAULT_RETENTION_MS);
    this.maxBytes = boundedPositiveInteger(maxBytes, DEFAULT_MAX_BYTES);
    this.maxBytesPerSession = boundedPositiveInteger(maxBytesPerSession, DEFAULT_MAX_BYTES_PER_SESSION);
    this.clock = clock;
    this.sessions = new Map();
    this.bytes = 0;
  }

  #removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.bytes = Math.max(0, this.bytes - session.bytes);
    this.sessions.delete(sessionId);
    return true;
  }

  #removeEntry(session, key) {
    const entry = session.entries.get(key);
    if (!entry) return false;
    session.entries.delete(key);
    session.bytes = Math.max(0, session.bytes - entry.bytes);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    return true;
  }

  #pruneExpired(now) {
    for (const [sessionId, session] of this.sessions) {
      if (now - session.touchedAt > this.retentionMs) this.#removeSession(sessionId);
    }
  }

  #touchSession(sessionId, session, now) {
    session.touchedAt = now;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  #evictSessionEntries(session) {
    while (
      session.entries.size > this.maxEntriesPerSession
      || session.bytes > this.maxBytesPerSession
    ) {
      const oldestKey = session.entries.keys().next().value;
      if (oldestKey == null) break;
      this.#removeEntry(session, oldestKey);
    }
  }

  #evictGlobal() {
    while (this.sessions.size > this.maxSessions || this.bytes > this.maxBytes) {
      const oldestSessionId = this.sessions.keys().next().value;
      if (oldestSessionId == null) break;
      this.#removeSession(oldestSessionId);
    }
  }

  get(sessionId, key) {
    if (!sessionId || !key) return null;
    const now = this.clock();
    this.#pruneExpired(now);
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const entry = session.entries.get(key);
    if (!entry) return null;
    session.entries.delete(key);
    session.entries.set(key, entry);
    this.#touchSession(sessionId, session, now);
    return structuredClone(entry.value);
  }

  set(sessionId, key, value) {
    if (!sessionId || !key || !value || typeof value !== 'object') return false;
    const entryBytes = estimateValueBytes(value) + 32 + stringBytes(key);
    if (entryBytes > this.maxBytes || entryBytes > this.maxBytesPerSession) return false;

    const now = this.clock();
    this.#pruneExpired(now);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { touchedAt: now, entries: new Map(), bytes: 0 };
      this.sessions.set(sessionId, session);
    } else {
      this.#removeEntry(session, key);
    }

    const entry = { value: structuredClone(value), bytes: entryBytes };
    session.entries.set(key, entry);
    session.bytes += entryBytes;
    this.bytes += entryBytes;
    this.#evictSessionEntries(session);

    if (session.entries.size === 0) {
      this.#removeSession(sessionId);
      return false;
    }

    this.#touchSession(sessionId, session, now);
    this.#evictGlobal();
    return this.sessions.get(sessionId) === session && session.entries.has(key);
  }

  resetSession(sessionId) {
    if (!sessionId) return 0;
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    const count = session.entries.size;
    this.#removeSession(sessionId);
    return count;
  }

  health() {
    this.#pruneExpired(this.clock());
    let entries = 0;
    for (const session of this.sessions.values()) entries += session.entries.size;
    return {
      sessions: this.sessions.size,
      entries,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      maxBytesPerSession: this.maxBytesPerSession,
    };
  }
}
