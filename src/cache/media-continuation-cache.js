const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 64;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

export class MediaContinuationCache {
  constructor({
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxEntriesPerSession = DEFAULT_MAX_ENTRIES_PER_SESSION,
    retentionMs = DEFAULT_RETENTION_MS,
    clock = () => Date.now(),
  } = {}) {
    this.maxSessions = maxSessions;
    this.maxEntriesPerSession = maxEntriesPerSession;
    this.retentionMs = retentionMs;
    this.clock = clock;
    this.sessions = new Map();
  }

  #pruneExpired(now) {
    for (const [sessionId, session] of this.sessions) {
      if (now - session.touchedAt > this.retentionMs) this.sessions.delete(sessionId);
    }
  }

  #touchSession(sessionId, session, now) {
    session.touchedAt = now;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  get(sessionId, key) {
    if (!sessionId || !key) return null;
    const now = this.clock();
    this.#pruneExpired(now);
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const value = session.entries.get(key);
    if (!value) return null;
    session.entries.delete(key);
    session.entries.set(key, value);
    this.#touchSession(sessionId, session, now);
    return structuredClone(value);
  }

  set(sessionId, key, value) {
    if (!sessionId || !key || !value || typeof value !== 'object') return false;
    const now = this.clock();
    this.#pruneExpired(now);
    let session = this.sessions.get(sessionId);
    if (!session) session = { touchedAt: now, entries: new Map() };
    session.entries.delete(key);
    session.entries.set(key, structuredClone(value));
    while (session.entries.size > this.maxEntriesPerSession) {
      session.entries.delete(session.entries.keys().next().value);
    }
    this.#touchSession(sessionId, session, now);
    while (this.sessions.size > this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    return true;
  }

  resetSession(sessionId) {
    if (!sessionId) return 0;
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    const count = session.entries.size;
    this.sessions.delete(sessionId);
    return count;
  }

  health() {
    let entries = 0;
    for (const session of this.sessions.values()) entries += session.entries.size;
    return { sessions: this.sessions.size, entries };
  }
}
