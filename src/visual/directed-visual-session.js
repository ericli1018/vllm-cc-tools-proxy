import crypto from 'node:crypto';

export class DirectedVisualSession {
  constructor() {
    this.sources = new Map();
    this.sourceIdByImageSha256 = new Map();
    this.nextId = 1;
  }

  register(entry = {}) {
    const sourceBuffer = Buffer.isBuffer(entry.sourceBuffer) ? Buffer.from(entry.sourceBuffer) : Buffer.alloc(0);
    const imageSha256 = sourceBuffer.length ? crypto.createHash('sha256').update(sourceBuffer).digest('hex') : '';
    if (imageSha256) {
      const existingId = this.sourceIdByImageSha256.get(imageSha256);
      if (existingId) {
        const existing = this.sources.get(existingId);
        if (existing) {
          const provenance = structuredClone(entry.provenance || {});
          existing.provenances.push(provenance);
          return { sourceId: existingId, reused: true };
        }
      }
    }

    const sourceId = `img_${String(this.nextId).padStart(2, '0')}`;
    this.nextId += 1;
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
}
