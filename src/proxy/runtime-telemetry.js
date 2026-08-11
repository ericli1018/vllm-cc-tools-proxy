function clampCount(value) {
  return Math.max(0, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);
}

export function formatUptime(ms) {
  const totalMinutes = Math.max(0, Math.floor(Number(ms || 0) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function safePhase(value) {
  const phase = String(value || '').trim().toLowerCase();
  return ['idle', 'waiting', 'thinking', 'response', 'tool', 'busy', 'compact', 'language', 'vision', 'stalled'].includes(phase)
    ? phase
    : 'waiting';
}

function safeText(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export class RuntimeTelemetry {
  constructor({ startedAt, maxRememberedSessions = 4096, clock = () => Date.now() } = {}) {
    this.clock = typeof clock === 'function' ? clock : (() => Date.now());
    this.startedAt = Number.isFinite(Number(startedAt)) ? Number(startedAt) : this.clock();
    this.maxRememberedSessions = maxRememberedSessions;
    this.activeRequests = new Set();
    this.activeSessions = new Map();
    this.busyRequests = new Set();
    this.bannerSessions = new Map();
    this.requestStates = new Map();
    this.lastSessionStates = new Map();
  }

  #rememberSession(sessionId, state) {
    const session = String(sessionId || '').trim();
    if (!session) return;
    this.lastSessionStates.delete(session);
    this.lastSessionStates.set(session, state);
    while (this.lastSessionStates.size > this.maxRememberedSessions) {
      const oldest = this.lastSessionStates.keys().next().value;
      this.lastSessionStates.delete(oldest);
    }
  }

  beginRequest({ requestId, sessionId = '' } = {}) {
    const id = String(requestId || '');
    const session = String(sessionId || '').trim();
    const now = this.clock();
    if (id) {
      this.activeRequests.add(id);
      this.requestStates.set(id, {
        requestId: id,
        sessionId: session,
        phase: 'waiting',
        startedAt: now,
        phaseStartedAt: now,
        updatedAt: now,
        receivedBytes: 0,
        lastByteAt: 0,
        throughputBps: 0,
        rateSampleAt: now,
        rateSampleBytes: 0,
        busyAttempt: 0,
        toolName: '',
        detail: '',
      });
    }
    if (session) {
      this.activeSessions.set(session, (this.activeSessions.get(session) || 0) + 1);
      this.#rememberSession(session, { phase: 'waiting', updatedAt: now });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const releasedAt = this.clock();
      if (id) {
        const state = this.requestStates.get(id);
        if (state?.sessionId) {
          this.#rememberSession(state.sessionId, {
            phase: 'idle',
            active: false,
            updatedAt: releasedAt,
            lastPhase: state.phase,
          });
        }
        this.requestStates.delete(id);
        this.activeRequests.delete(id);
        this.busyRequests.delete(id);
      }
      if (session) {
        const remaining = (this.activeSessions.get(session) || 1) - 1;
        if (remaining > 0) this.activeSessions.set(session, remaining);
        else this.activeSessions.delete(session);
      }
    };
  }

  updateRequest(requestId, patch = {}) {
    const id = String(requestId || '');
    const state = this.requestStates.get(id);
    if (!state) return false;
    const now = this.clock();
    const nextPhase = patch.phase === undefined ? state.phase : safePhase(patch.phase);
    if (nextPhase !== state.phase) state.phaseStartedAt = now;
    state.phase = nextPhase;
    if (patch.busyAttempt !== undefined) state.busyAttempt = clampCount(patch.busyAttempt);
    if (patch.toolName !== undefined) state.toolName = safeText(patch.toolName, 80);
    if (patch.detail !== undefined) state.detail = safeText(patch.detail, 120);
    state.updatedAt = now;
    if (state.sessionId) this.#rememberSession(state.sessionId, { phase: state.phase, updatedAt: now });
    return true;
  }

  observeBytes(requestId, receivedBytes, now = this.clock()) {
    const id = String(requestId || '');
    const state = this.requestStates.get(id);
    const bytes = Math.max(0, Number.isFinite(Number(receivedBytes)) ? Number(receivedBytes) : 0);
    if (!state) return false;
    if (bytes < state.receivedBytes) return false;
    if (state.receivedBytes === 0 && bytes > 0 && now <= state.rateSampleAt) {
      state.rateSampleAt = now;
      state.rateSampleBytes = bytes;
    }
    if (state.rateSampleAt > 0 && now > state.rateSampleAt && now - state.rateSampleAt >= 500) {
      state.throughputBps = Math.max(0, (bytes - state.rateSampleBytes) * 1000 / (now - state.rateSampleAt));
      state.rateSampleAt = now;
      state.rateSampleBytes = bytes;
    }
    state.receivedBytes = bytes;
    state.lastByteAt = now;
    state.updatedAt = now;
    return true;
  }

  setBusy(requestId, busy, { attempt = 0 } = {}) {
    const id = String(requestId || '');
    if (!id) return;
    if (busy) {
      this.busyRequests.add(id);
      this.updateRequest(id, { phase: 'busy', busyAttempt: attempt });
    } else {
      this.busyRequests.delete(id);
    }
  }

  claimBanner(sessionId) {
    const session = String(sessionId || '').trim();
    if (!session || this.bannerSessions.has(session)) return false;
    this.bannerSessions.set(session, this.clock());
    while (this.bannerSessions.size > this.maxRememberedSessions) {
      const oldest = this.bannerSessions.keys().next().value;
      this.bannerSessions.delete(oldest);
    }
    return true;
  }

  snapshotSession(sessionId, now = this.clock()) {
    const session = String(sessionId || '').trim();
    if (!session) return { known: false, active: false, phase: 'idle' };
    const active = [...this.requestStates.values()]
      .filter((state) => state.sessionId === session)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (active) {
      const elapsedMs = Math.max(0, now - active.startedAt);
      const idleMs = active.lastByteAt > 0 ? Math.max(0, now - active.lastByteAt) : 0;
      const phase = active.lastByteAt > 0 && idleMs >= 30_000 && ['thinking', 'response', 'tool'].includes(active.phase)
        ? 'stalled'
        : active.phase;
      return {
        known: true,
        active: true,
        requestId: active.requestId,
        phase,
        underlyingPhase: active.phase,
        elapsedMs,
        phaseElapsedMs: Math.max(0, now - active.phaseStartedAt),
        receivedBytes: active.receivedBytes,
        throughputBps: active.throughputBps,
        idleMs,
        busyAttempt: active.busyAttempt,
        toolName: active.toolName,
        detail: active.detail,
        pulseIndex: Math.floor(Math.max(0, now - active.phaseStartedAt) / 1000) % 4,
        updatedAt: active.updatedAt,
      };
    }
    const remembered = this.lastSessionStates.get(session);
    if (!remembered && !this.bannerSessions.has(session)) return { known: false, active: false, phase: 'idle' };
    return {
      known: true,
      active: false,
      phase: 'idle',
      lastPhase: safePhase(remembered?.lastPhase || remembered?.phase || 'idle'),
      elapsedMs: 0,
      phaseElapsedMs: 0,
      receivedBytes: 0,
      throughputBps: 0,
      idleMs: 0,
      busyAttempt: 0,
      toolName: '',
      detail: '',
      pulseIndex: 0,
      updatedAt: remembered?.updatedAt || 0,
    };
  }

  snapshot(now = this.clock()) {
    return {
      uptimeMs: Math.max(0, now - this.startedAt),
      sessions: this.activeSessions.size,
      active: this.activeRequests.size,
      waiting: this.busyRequests.size,
    };
  }
}

function featureState(enabled) {
  return enabled ? '● ON' : '○ OFF';
}

function fitLine(text, width) {
  const chars = [...String(text)];
  if (chars.length >= width) return chars.slice(0, width).join('');
  return `${text}${' '.repeat(width - chars.length)}`;
}

export function formatStartupBanner({ version, snapshot = {}, features = {} } = {}) {
  const width = 47;
  const title = '─◆ CC TOOL PROXY ';
  const top = `╭${title}${'─'.repeat(Math.max(0, width - [...title].length))}╮`;
  const row = (text) => `│${fitLine(`  ${text}`, width)}│`;
  const bottom = `╰${'─'.repeat(width)}╯`;
  return [
    top,
    row(`VERSION   ${version || 'unknown'}    UPTIME   ${formatUptime(snapshot.uptimeMs)}`),
    row(`SESSIONS  ${clampCount(snapshot.sessions)}    ACTIVE   ${clampCount(snapshot.active)}    WAIT   ${clampCount(snapshot.waiting)}`),
    row(`COMPACT ${featureState(features.compact)}   LANG ${featureState(features.lang)}   VISION ${featureState(features.vision)}`),
    bottom,
  ].join('\n');
}
