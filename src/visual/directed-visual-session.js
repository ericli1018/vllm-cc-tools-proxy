import crypto from 'node:crypto';

export class DirectedVisualSession {
  constructor() {
    this.sources = new Map();
    this.sourceIdByImageSha256 = new Map();
    this.nextId = 1;
  }

  register(entry = {}) {
    const sourceBuffer = Buffer.isBuffer(entry.sourceBuffer) ? Buffer.from(entry.sourceBuffer) : Buffer.alloc(0);
    const imageSha256 = sourceBuffer.length ? crypto.createHash('sha256').update(sourceBuffer).digest('hex') : (/^[a-f0-9]{64}$/.test(entry.imageSha256 || '') ? entry.imageSha256 : '');
    if (imageSha256) {
      const existingId = this.sourceIdByImageSha256.get(imageSha256);
      if (existingId) {
        const existing = this.sources.get(existingId);
        if (existing) {
          const provenance = structuredClone(entry.provenance || {});
          existing.provenances.push(provenance);
          if (sourceBuffer.length && !existing.sourceBuffer.length) {
            existing.sourceBuffer = sourceBuffer;
            existing.normalized = entry.normalized || null;
          }
          return { sourceId: existingId, reused: true };
        }
      }
    }

    let sourceId = /^img_\d+$/.test(entry.sourceId || '') && !this.sources.has(entry.sourceId) ? entry.sourceId : '';
    while (!sourceId || this.sources.has(sourceId)) {
      sourceId = `img_${String(this.nextId).padStart(2, '0')}`;
      this.nextId += 1;
    }
    const provenance = structuredClone(entry.provenance || {});
    const record = {
      sourceId,
      imageSha256,
      filename: String(entry.filename || 'image'),
      sourceKind: String(entry.sourceKind || 'direct_image'),
      provenance,
      provenances: [provenance],
      mediaType: String(entry.mediaType || entry.normalized?.mediaType || 'image/png'),
      sourceBuffer,
      normalized: entry.normalized ? { ...entry.normalized, buffer: Buffer.from(entry.normalized.buffer || Buffer.alloc(0)) } : null,
    };
    this.sources.set(sourceId, record);
    if (imageSha256) this.sourceIdByImageSha256.set(imageSha256, sourceId);
    return { sourceId, reused: false };
  }

  get(sourceId) {
    return this.sources.get(String(sourceId || '')) || null;
  }

  hasSources() {
    return this.sources.size > 0;
  }

  sourceIds() {
    return [...this.sources.keys()];
  }

  sourceIdsForMessageIndex(messageIndex, { sourceKinds = null } = {}) {
    if (!Number.isInteger(messageIndex) || messageIndex < 0) return [];
    const allowed = Array.isArray(sourceKinds) ? new Set(sourceKinds.map((item) => String(item || ''))) : null;
    const ids = [];
    for (const [sourceId, record] of this.sources.entries()) {
      const provenances = Array.isArray(record?.provenances) ? record.provenances : [];
      const matched = provenances.some((provenance) => (
        Number(provenance?.messageIndex) === messageIndex
        && (!allowed || allowed.has(String(provenance?.sourceKind || record?.sourceKind || '')))
      ));
      if (matched) ids.push(sourceId);
    }
    return ids;
  }
  latestSourceIds({ sourceKinds = null, beforeMessageIndex = Infinity } = {}) {
    const allowed = Array.isArray(sourceKinds) ? new Set(sourceKinds.map((item) => String(item || ''))) : null;
    let latest = -1;
    const ids = [];
    for (const [sourceId, record] of this.sources.entries()) {
      const provenances = Array.isArray(record?.provenances) ? record.provenances : [];
      for (const provenance of provenances) {
        const index = Number(provenance?.messageIndex);
        const kind = String(provenance?.sourceKind || record?.sourceKind || '');
        if (!Number.isInteger(index) || index < 0 || index >= beforeMessageIndex || (allowed && !allowed.has(kind))) continue;
        if (index > latest) { latest = index; ids.length = 0; }
        if (index === latest && !ids.includes(sourceId)) ids.push(sourceId);
      }
    }
    return ids;
  }

}
