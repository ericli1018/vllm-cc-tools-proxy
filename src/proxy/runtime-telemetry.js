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

export class RuntimeTelemetry {
  constructor({ startedAt = Date.now(), maxRememberedSessions = 4096 } = {}) {
    this.startedAt = startedAt;
    this.maxRememberedSessions = maxRememberedSessions;
    this.activeRequests = new Set();
    this.activeSessions = new Map();
    this.busyRequests = new Set();
    this.bannerSessions = new Map();
  }

  beginRequest({ requestId, sessionId = '' } = {}) {
    const id = String(requestId || '');
    const session = String(sessionId || '');
    if (id) this.activeRequests.add(id);
    if (session) this.activeSessions.set(session, (this.activeSessions.get(session) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (id) {
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

  setBusy(requestId, busy) {
    const id = String(requestId || '');
    if (!id) return;
    if (busy) this.busyRequests.add(id);
    else this.busyRequests.delete(id);
  }

  claimBanner(sessionId) {
    const session = String(sessionId || '').trim();
    if (!session || this.bannerSessions.has(session)) return false;
    this.bannerSessions.set(session, Date.now());
    while (this.bannerSessions.size > this.maxRememberedSessions) {
      const oldest = this.bannerSessions.keys().next().value;
      this.bannerSessions.delete(oldest);
    }
    return true;
  }

  snapshot(now = Date.now()) {
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
