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
  constructor({ startedAt, maxRememberedSessions = 4096, throughputWindowMs = 5000, clock = () => Date.now() } = {}) {
    this.clock = typeof clock === 'function' ? clock : (() => Date.now());
    this.startedAt = Number.isFinite(Number(startedAt)) ? Number(startedAt) : this.clock();
    this.maxRememberedSessions = maxRememberedSessions;
    this.throughputWindowMs = Math.max(1000, Number(throughputWindowMs) || 5000);
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
        modelSamples: [],
        round: 0,
        roundActive: false,
        roundStartedAt: 0,
        roundEndedAt: 0,
        roundReceivedBytes: 0,
        roundLastByteAt: 0,
        roundSamples: [],
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

  beginModelRound(requestId, { round = 1, startedAt = this.clock() } = {}) {
    const id = String(requestId || '');
    const state = this.requestStates.get(id);
    if (!state) return false;
    const now = Number.isFinite(Number(startedAt)) ? Number(startedAt) : this.clock();
    state.round = Math.max(1, clampCount(round) || 1);
    state.roundActive = true;
    state.roundStartedAt = now;
    state.roundEndedAt = 0;
    state.roundReceivedBytes = 0;
    state.roundLastByteAt = 0;
    state.roundSamples = [];
    state.phase = 'waiting';
    state.phaseStartedAt = now;
    state.busyAttempt = 0;
    state.toolName = '';
    state.detail = '';
    state.updatedAt = now;
    if (state.sessionId) this.#rememberSession(state.sessionId, { phase: state.phase, updatedAt: now });
    return true;
  }

  endModelRound(requestId, { endedAt = this.clock() } = {}) {
    const id = String(requestId || '');
    const state = this.requestStates.get(id);
    if (!state) return false;
    const now = Number.isFinite(Number(endedAt)) ? Number(endedAt) : this.clock();
    state.roundActive = false;
    state.roundEndedAt = now;
    state.updatedAt = now;
    return true;
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

  observeModelDelta(requestId, deltaBytes, now = this.clock()) {
    const id = String(requestId || '');
    const state = this.requestStates.get(id);
    const delta = Math.max(0, Number.isFinite(Number(deltaBytes)) ? Number(deltaBytes) : 0);
    if (!state || delta <= 0) return false;
    state.receivedBytes += delta;
    state.lastByteAt = now;
    state.updatedAt = now;
    state.modelSamples.push({ at: now, bytes: delta });
    const cutoff = now - this.throughputWindowMs;
    while (state.modelSamples.length && state.modelSamples[0].at < cutoff) state.modelSamples.shift();

    // Backward compatibility for callers/tests that have not explicitly opened a round.
    if (!state.roundActive && state.round === 0) {
      state.round = 1;
      state.roundActive = true;
      state.roundStartedAt = state.startedAt;
      state.roundEndedAt = 0;
      state.roundReceivedBytes = 0;
      state.roundLastByteAt = 0;
      state.roundSamples = [];
    }
    if (state.roundActive) {
      state.roundReceivedBytes += delta;
      state.roundLastByteAt = now;
      state.roundSamples.push({ at: now, bytes: delta });
      while (state.roundSamples.length && state.roundSamples[0].at < cutoff) state.roundSamples.shift();
    }
    return true;
  }

  // Backward-compatible cumulative observer for older tests/callers. New runtime code should use observeModelDelta().
  observeBytes(requestId, receivedBytes, now = this.clock()) {
    const id = String(requestId || '');
    const state = this.requestStates.get(id);
    const bytes = Math.max(0, Number.isFinite(Number(receivedBytes)) ? Number(receivedBytes) : 0);
    if (!state || bytes < state.receivedBytes) return false;
    const delta = bytes - state.receivedBytes;
    if (delta <= 0) return true;
    return this.observeModelDelta(id, delta, now);
  }

  #rollingThroughputFromSamples(samples, now) {
    const cutoff = now - this.throughputWindowMs;
    const recent = samples.filter((sample) => sample.at >= cutoff);
    if (!recent.length) return 0;
    const bytes = recent.reduce((sum, sample) => sum + sample.bytes, 0);
    const oldestAt = recent[0].at;
    const elapsedMs = Math.max(1000, Math.min(this.throughputWindowMs, now - oldestAt || 1000));
    return Math.max(0, bytes * 1000 / elapsedMs);
  }

  #rollingThroughput(state, now) {
    return this.#rollingThroughputFromSamples(state.modelSamples, now);
  }

  #rollingRoundThroughput(state, now) {
    return this.#rollingThroughputFromSamples(state.roundSamples, now);
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

  snapshotRequest(requestId, now = this.clock()) {
    const id = String(requestId || '');
    const state = this.requestStates.get(id);
    if (!state) return { known: false, active: false, phase: 'idle' };

    const roundVisible = Boolean(state.roundActive);
    const visibleLastByteAt = roundVisible ? state.roundLastByteAt : 0;
    const idleMs = visibleLastByteAt > 0 ? Math.max(0, now - visibleLastByteAt) : 0;
    const basePhase = state.phase;
    const phase = roundVisible && visibleLastByteAt > 0 && idleMs >= 30_000
      && ['thinking', 'response', 'tool'].includes(basePhase)
      ? 'stalled'
      : basePhase;
    const elapsedAnchor = roundVisible && state.roundStartedAt > 0 ? state.roundStartedAt : state.phaseStartedAt;

    return {
      known: true,
      active: true,
      requestId: state.requestId,
      sessionId: state.sessionId,
      phase,
      underlyingPhase: basePhase,
      round: state.round,
      roundActive: state.roundActive,
      elapsedMs: Math.max(0, now - elapsedAnchor),
      phaseElapsedMs: Math.max(0, now - state.phaseStartedAt),
      receivedBytes: roundVisible ? state.roundReceivedBytes : 0,
      throughputBps: roundVisible ? this.#rollingRoundThroughput(state, now) : 0,
      idleMs,
      busyAttempt: state.busyAttempt,
      toolName: state.toolName,
      detail: state.detail,
      pulseIndex: Math.floor(Math.max(0, now - state.phaseStartedAt) / 1000) % 4,
      updatedAt: state.updatedAt,
    };
  }

  snapshotSession(sessionId, now = this.clock()) {
    const session = String(sessionId || '').trim();
    if (!session) return { known: false, active: false, phase: 'idle' };
    const active = [...this.requestStates.values()]
      .filter((state) => state.sessionId === session)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (active) return this.snapshotRequest(active.requestId, now);
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
