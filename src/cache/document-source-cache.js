import fs from 'node:fs/promises';
import path from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assertSha(value, name) {
  if (!SHA256_PATTERN.test(String(value || ''))) throw new TypeError(`${name} must be a 64-character lowercase SHA-256 hex string`);
}

function safeFilename(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text.slice(0, 160);
}

export class DocumentSourceCache {
  constructor({ rootDir = '', retentionMs = 7 * 24 * 60 * 60 * 1000, clock = () => Date.now(), fsImpl = fs } = {}) {
    this.rootDir = rootDir ? path.join(rootDir, 'document-sources') : '';
    this.refsDir = this.rootDir ? path.join(this.rootDir, 'refs') : '';
    this.blobsDir = this.rootDir ? path.join(this.rootDir, 'blobs') : '';
    this.retentionMs = retentionMs;
    this.clock = clock;
    this.fs = fsImpl;
    this.memory = new Map();
  }

  async initialize() {
    if (!this.rootDir) return this;
    await this.fs.mkdir(this.refsDir, { recursive: true, mode: 0o700 });
    await this.fs.mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    return this;
  }

  #expired(updatedAt) {
    return this.retentionMs > 0 && this.clock() - Number(updatedAt || 0) > this.retentionMs;
  }

  async put({ readSourceRef, sourceSha256, buffer, filename = '' }) {
    assertSha(readSourceRef, 'readSourceRef');
    assertSha(sourceSha256, 'sourceSha256');
    if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
    const value = { sourceSha256, filename: safeFilename(filename), updatedAt: this.clock() };
    if (!this.rootDir) {
      this.memory.set(readSourceRef, { ...value, buffer: Buffer.from(buffer) });
      return true;
    }
    await this.initialize();
    const sourcePath = path.join(this.blobsDir, `${sourceSha256}.pdf`);
    try {
      await this.fs.access(sourcePath);
    } catch {
      const temp = `${sourcePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      await this.fs.writeFile(temp, buffer, { mode: 0o600, flag: 'wx' });
      try { await this.fs.rename(temp, sourcePath); }
      catch (error) { await this.fs.rm(temp, { force: true }).catch(() => {}); if (error?.code !== 'EEXIST') throw error; }
    }
    const refPath = path.join(this.refsDir, `${readSourceRef}.json`);
    const tempRef = `${refPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await this.fs.writeFile(tempRef, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await this.fs.rename(tempRef, refPath);
    return true;
  }

  async resolve(readSourceRef) {
    assertSha(readSourceRef, 'readSourceRef');
    if (!this.rootDir) {
      const value = this.memory.get(readSourceRef);
      if (!value) return null;
      if (this.#expired(value.updatedAt)) { this.memory.delete(readSourceRef); return null; }
      value.updatedAt = this.clock();
      return { sourceSha256: value.sourceSha256, filename: value.filename, buffer: Buffer.from(value.buffer), sourcePath: `memory://${value.sourceSha256}` };
    }
    await this.initialize();
    const refPath = path.join(this.refsDir, `${readSourceRef}.json`);
    let value;
    try { value = JSON.parse((await this.fs.readFile(refPath)).toString('utf8')); }
    catch { return null; }
    if (!SHA256_PATTERN.test(String(value?.sourceSha256 || '')) || this.#expired(value?.updatedAt)) {
      await this.fs.rm(refPath, { force: true }).catch(() => {});
      return null;
    }
    const sourcePath = path.join(this.blobsDir, `${value.sourceSha256}.pdf`);
    try {
      const buffer = await this.fs.readFile(sourcePath);
      value.updatedAt = this.clock();
      await this.fs.writeFile(refPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      return { sourceSha256: value.sourceSha256, filename: safeFilename(value.filename), buffer, sourcePath };
    } catch {
      await this.fs.rm(refPath, { force: true }).catch(() => {});
      return null;
    }
  }
}
