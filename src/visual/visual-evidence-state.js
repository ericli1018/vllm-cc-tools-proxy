import crypto from 'node:crypto';

export const VISUAL_EVIDENCE_UNSEEN = 'UNSEEN';
export const VISUAL_EVIDENCE_RESOLVED = 'RESOLVED';
export const VISUAL_EVIDENCE_RETRYABLE_FAILED = 'RETRYABLE_FAILED';

export function visualEvidenceIdentity({ sessionId = '', imageSha256 = '' } = {}) {
  const session = String(sessionId || '').trim();
  const image = String(imageSha256 || '').trim().toLowerCase();
  if (!session || !/^[a-f0-9]{64}$/.test(image)) return '';
  return crypto.createHash('sha256').update(`vcc-visual-evidence-v1\n${session}\n${image}`).digest('hex');
}

export class VisualEvidenceStateStore {
  constructor({ retentionMs = 60 * 60 * 1000, maxEntries = 256, clock = () => Date.now() } = {}) {
    this.retentionMs = Math.max(0, Number(retentionMs) || 0);
    this.maxEntries = Math.max(1, Number(maxEntries) || 256);
    this.clock = clock;
    this.entries = new Map();
  }

  #prune() {
    const now = this.clock();
    if (this.retentionMs > 0) {
      for (const [key, entry] of this.entries) {
        if (now - entry.updatedAt > this.retentionMs) this.entries.delete(key);
      }
    }
    if (this.entries.size <= this.maxEntries) return;
    const ordered = [...this.entries.entries()].sort((a,b) => a[1].updatedAt - b[1].updatedAt);
    while (this.entries.size > this.maxEntries && ordered.length) this.entries.delete(ordered.shift()[0]);
  }

  get(key) {
    if (!key) return null;
    this.#prune();
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.updatedAt = this.clock();
    return structuredClone(entry.value);
  }

  setResolved(key, { plan, perception, sourceId = '' } = {}) {
    if (!key) return false;
    const now = this.clock();
    this.entries.set(key, { updatedAt: now, value: {
      status: VISUAL_EVIDENCE_RESOLVED,
      plan: structuredClone(plan || null),
      perception: structuredClone(perception || null),
      source_id: String(sourceId || ''),
      updated_at: now,
    } });
    this.#prune();
    return true;
  }

  setRetryableFailed(key, { code = 'visual_query_planner_failed', detail = '' } = {}) {
    if (!key) return false;
    const now = this.clock();
    this.entries.set(key, { updatedAt: now, value: {
      status: VISUAL_EVIDENCE_RETRYABLE_FAILED,
      code: String(code || 'visual_query_planner_failed'),
      detail: String(detail || ''),
      updated_at: now,
    } });
    this.#prune();
    return true;
  }

  delete(key) { return this.entries.delete(key); }
  health() { this.#prune(); return { entries: this.entries.size, max_entries: this.maxEntries }; }
}


function replaceSupportRef(value, fromId, toId) {
  const text=String(value || '');
  return text.startsWith(`${fromId}:`) ? `${toId}${text.slice(fromId.length)}` : text;
}

export function materializeResolvedVisualEvidence(state, currentSourceId) {
  if (!state || state.status !== VISUAL_EVIDENCE_RESOLVED) return null;
  const fromId=String(state.source_id || state.plan?.source_ids?.[0] || '');
  const toId=String(currentSourceId || '');
  if (!fromId || !toId) return null;
  const plan=structuredClone(state.plan || {});
  const perception=structuredClone(state.perception || {});
  if (Array.isArray(plan.source_ids)) plan.source_ids=plan.source_ids.map((id)=>String(id)===fromId?toId:id);
  if (Array.isArray(perception.answers)) {
    for (const answer of perception.answers) {
      if (Array.isArray(answer?.source_ids)) answer.source_ids=answer.source_ids.map((id)=>String(id)===fromId?toId:id);
      if (Array.isArray(answer?.support_refs)) answer.support_refs=answer.support_refs.map((ref)=>replaceSupportRef(ref,fromId,toId));
    }
  }
  if (Array.isArray(perception.source_results)) {
    for (const result of perception.source_results) {
      if (String(result?.source_id || '')===fromId) result.source_id=toId;
    }
  }
  return { plan, perception };
}
