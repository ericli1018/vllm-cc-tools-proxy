import crypto from 'node:crypto';

export class DirectedVisualSession {
  constructor() {
    this.sources = new Map();
    this.nextId = 1;
  }

  register(entry = {}) {
    const sourceId = `img_${String(this.nextId).padStart(2, '0')}`;
    this.nextId += 1;
    const sourceBuffer = Buffer.isBuffer(entry.sourceBuffer) ? Buffer.from(entry.sourceBuffer) : Buffer.alloc(0);
    const record = {
      sourceId,
      imageSha256: sourceBuffer.length ? crypto.createHash('sha256').update(sourceBuffer).digest('hex') : '',
      filename: String(entry.filename || 'image'),
      sourceKind: String(entry.sourceKind || 'direct_image'),
      provenance: structuredClone(entry.provenance || {}),
      mediaType: String(entry.mediaType || entry.normalized?.mediaType || 'image/png'),
      sourceBuffer,
      normalized: entry.normalized ? { ...entry.normalized, buffer: Buffer.from(entry.normalized.buffer || Buffer.alloc(0)) } : null,
    };
    this.sources.set(sourceId, record);
    return { sourceId };
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
