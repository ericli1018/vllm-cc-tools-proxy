import crypto from 'node:crypto';

const TOOL_NAMES = new Set(['agent', 'task']);

function fingerprint(value) {
  const text = String(value || '');
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function textFragments(content, out = []) {
  if (typeof content === 'string') {
    if (content) out.push(content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) out.push(block);
    } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      out.push(block.text);
    }
  }
  return out;
}

function requestTextFingerprints(request) {
  const values = new Set();
  for (const message of Array.isArray(request?.messages) ? request.messages : []) {
    for (const text of textFragments(message?.content)) values.add(fingerprint(text));
  }
  return values;
}

export class SubagentDisplayRegistry {
  constructor({ ttlMs = 30 * 60 * 1000, maxAgents = 512, maxPending = 512 } = {}) {
    this.ttlMs = ttlMs;
    this.maxAgents = maxAgents;
    this.maxPending = maxPending;
    this.agents = new Map();
    this.pending = [];
  }

  #prune(now = Date.now()) {
    const cutoff = now - this.ttlMs;
    this.pending = this.pending.filter((entry) => entry.createdAt >= cutoff);
    for (const [key, entry] of this.agents) {
      if (entry.updatedAt < cutoff) this.agents.delete(key);
    }
    while (this.pending.length > this.maxPending) this.pending.shift();
    while (this.agents.size > this.maxAgents) this.agents.delete(this.agents.keys().next().value);
  }

  recordHandoffs(sessionId, response = {}) {
    const session = String(sessionId || '');
    const now = Date.now();
    let added = 0;
    for (const block of Array.isArray(response?.content) ? response.content : []) {
      if (block?.type !== 'tool_use') continue;
      const toolName = String(block?.name || '').trim();
      if (!TOOL_NAMES.has(toolName.toLowerCase())) continue;
      const title = normalizeTitle(block?.input?.description);
      const prompt = typeof block?.input?.prompt === 'string' ? block.input.prompt : '';
      if (!title || !prompt) continue;
      this.pending.push({ session, title, promptFingerprint: fingerprint(prompt), createdAt: now });
      added += 1;
    }
    this.#prune(now);
    return added;
  }

  bindRequest({ sessionId, agentId, request = {} } = {}) {
    const session = String(sessionId || '');
    const agent = String(agentId || '');
    if (!agent) return { title: '', source: '', title_fingerprint: '' };
    const now = Date.now();
    this.#prune(now);
    const key = agent;
    const existing = this.agents.get(key);
    if (existing) {
      existing.updatedAt = now;
      this.agents.delete(key);
      this.agents.set(key, existing);
      return { title: existing.title, source: 'agent_id', title_fingerprint: fingerprint(existing.title).slice(0, 12) };
    }

    const fingerprints = requestTextFingerprints(request);
    let index = this.pending.findIndex((entry) => entry.session === session && fingerprints.has(entry.promptFingerprint));
    let source = 'prompt_match';
    if (index < 0) {
      const exactGlobal = this.pending
        .map((entry, pendingIndex) => ({ entry, pendingIndex }))
        .filter(({ entry }) => fingerprints.has(entry.promptFingerprint));
      if (exactGlobal.length === 1) index = exactGlobal[0].pendingIndex;
    }
    if (index < 0) {
      const sameSession = this.pending
        .map((entry, pendingIndex) => ({ entry, pendingIndex }))
        .filter(({ entry }) => entry.session === session);
      if (sameSession.length === 1) {
        index = sameSession[0].pendingIndex;
        source = 'single_pending';
      }
    }
    if (index < 0) return { title: '', source: '', title_fingerprint: '' };
    const [matched] = this.pending.splice(index, 1);
    this.agents.set(key, { title: matched.title, updatedAt: now });
    this.#prune(now);
    return { title: matched.title, source, title_fingerprint: fingerprint(matched.title).slice(0, 12) };
  }

  health() {
    this.#prune();
    return { agents: this.agents.size, pending: this.pending.length };
  }
}
