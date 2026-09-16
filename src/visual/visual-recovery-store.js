import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const FORMAT_VERSION = 1;
const MAX_METADATA_BYTES = 256 * 1024;
const ASSET_ID_PATTERN = /^vra_[A-Za-z0-9_-]{43}$/;

function digest(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function cloneJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error });
  }
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return JSON.parse(serialized);
}

function encodedJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error });
  }
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable`);
  const buffer = Buffer.from(serialized);
  if (buffer.byteLength > MAX_METADATA_BYTES) {
    throw new RangeError(`${label} metadata exceeds the 256 KiB record limit`);
  }
  return buffer;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validRecoveryId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function validEvidence(value) {
  return isPlainObject(value)
    && Object.hasOwn(value, 'plan')
    && Object.hasOwn(value, 'perception')
    && typeof value.intentKey === 'string'
    && typeof value.sourceId === 'string';
}

function validSourceRecord(record) {
  return isPlainObject(record)
    && !Object.hasOwn(record, 'sourceBuffer')
    && ASSET_ID_PATTERN.test(record.assetId)
    && typeof record.sourceId === 'string'
    && validSha256(record.imageSha256)
    && typeof record.filename === 'string'
    && typeof record.sourceKind === 'string'
    && typeof record.mediaType === 'string'
    && (record.locator === null || isPlainObject(record.locator))
    && (record.provenance === null || isPlainObject(record.provenance))
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt)
    && (!Object.hasOwn(record, 'evidence') || validEvidence(record.evidence));
}

function validRecoveryRecord(record) {
  return isPlainObject(record)
    && validRecoveryId(record.id)
    && Array.isArray(record.assetIds)
    && record.assetIds.every((assetId) => typeof assetId === 'string')
    && Array.isArray(record.sourceHints)
    && record.sourceHints.every(isPlainObject)
    && typeof record.intentKey === 'string'
    && Number.isInteger(record.attempts)
    && record.attempts >= 0
    && typeof record.status === 'string'
    && Array.isArray(record.toolCalls)
    && record.toolCalls.every(isPlainObject);
}

function compareNewest(left, right) {
  return right.updatedAt - left.updatedAt || String(left.sortId).localeCompare(String(right.sortId));
}

export class VisualRecoveryStore {
  constructor({
    rootDir = '',
    retentionMs = 3_600_000,
    maxEntries = 256,
    maxBytes = 67_108_864,
    clock = Date.now
  } = {}) {
    this.rootDir = typeof rootDir === 'string' && rootDir.length > 0
      ? path.resolve(rootDir, 'visual-recovery-v1')
      : '';
    this.retentionMs = positiveLimit(retentionMs, 3_600_000);
    this.maxEntries = positiveLimit(maxEntries, 256);
    this.maxBytes = positiveLimit(maxBytes, 67_108_864);
    this.clock = typeof clock === 'function' ? clock : Date.now;
    this.sources = new Map();
    this.recoveries = new Map();
    this.blobs = new Map();
    this.blobBytes = 0;
    this.anonymousScope = `anonymous:${crypto.randomBytes(16).toString('hex')}`;
    this.initialized = false;
    this.initializing = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (this.initialized) return this;
    if (this.initializing) return this.initializing;
    this.initializing = this.#initializeOnce();
    try {
      await this.initializing;
      this.initialized = true;
      return this;
    } finally {
      this.initializing = null;
    }
  }

  async putSource(sessionId, source) {
    await this.initialize();
    if (!isPlainObject(source)) throw new TypeError('source must be an object');
    if (!Buffer.isBuffer(source.sourceBuffer)) throw new TypeError('sourceBuffer must be a Buffer');
    const publicSession = this.#writeSession(sessionId);
    const scope = this.#scope(publicSession);
    const sourceBuffer = Buffer.from(source.sourceBuffer);
    const computedHash = digest(sourceBuffer);
    if (source.imageSha256 != null && source.imageSha256 !== '' && source.imageSha256 !== computedHash) {
      throw new Error('sourceBuffer SHA-256 does not match imageSha256');
    }
    const assetId = this.#assetId(scope, computedHash);

    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const key = this.#sourceKey(scope, assetId);
      const existing = this.sources.get(key)?.value;
      const record = {
        assetId,
        sourceId: cloneJson(source.sourceId, 'sourceId'),
        imageSha256: computedHash,
        filename: cloneJson(source.filename, 'filename'),
        sourceKind: cloneJson(source.sourceKind, 'sourceKind'),
        mediaType: cloneJson(source.mediaType, 'mediaType'),
        locator: Object.hasOwn(source, 'locator')
          ? cloneJson(source.locator, 'locator')
          : cloneJson(existing?.locator ?? null, 'locator'),
        provenance: Object.hasOwn(source, 'provenance')
          ? cloneJson(source.provenance, 'provenance')
          : cloneJson(existing?.provenance ?? null, 'provenance'),
        updatedAt: this.#now()
      };
      if (existing && Object.hasOwn(existing, 'evidence')) record.evidence = cloneJson(existing.evidence, 'evidence');

      if (!validSourceRecord(record)) throw new TypeError('source metadata fields are malformed');

      const wrapper = this.#sourceWrapper(publicSession, record);
      const metadataBytes = encodedJson(wrapper, 'source');
      if (this.#isPersistent(publicSession)) {
        const hadBlob = this.blobs.has(key);
        let installedNewBlob = false;
        try {
          await this.#writeAtomic(this.#blobPath(publicSession, assetId), sourceBuffer);
          installedNewBlob = !hadBlob;
          await this.#writeAtomic(this.#sourcePath(publicSession, assetId), metadataBytes);
        } catch (error) {
          if (installedNewBlob) {
            try {
              await this.#removeFile(this.#blobPath(publicSession, assetId));
              await this.#cleanupEmptySession(publicSession);
            } catch (cleanupError) {
              error.cleanupError = cleanupError;
            }
          }
          throw error;
        }
      }

      this.sources.set(key, { sessionId: publicSession, scope, updatedAt: record.updatedAt, value: record });
      this.#setBlob(key, {
        sessionId: publicSession,
        scope,
        assetId,
        size: sourceBuffer.byteLength,
        touchedAt: record.updatedAt,
        buffer: this.#isPersistent(publicSession) ? null : sourceBuffer
      });
      await this.#pruneEntries();
      await this.#pruneBlobs();
      return cloneJson(record, 'source');
    });
  }

  async getSource(sessionId, assetId) {
    await this.initialize();
    if (!this.#readableSession(sessionId) || !this.#validAssetId(assetId)) return null;
    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const entry = this.sources.get(this.#sourceKey(this.#scope(sessionId), assetId));
      return entry ? cloneJson(entry.value, 'source') : null;
    });
  }

  async listSources(sessionId) {
    await this.initialize();
    if (!this.#readableSession(sessionId)) return [];
    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const scope = this.#scope(sessionId);
      return [...this.sources.values()]
        .filter((entry) => entry.scope === scope)
        .map((entry) => ({ ...entry, sortId: entry.value.assetId }))
        .sort(compareNewest)
        .map((entry) => cloneJson(entry.value, 'source'));
    });
  }

  async getBytes(sessionId, assetId) {
    await this.initialize();
    if (!this.#readableSession(sessionId) || !this.#validAssetId(assetId)) return null;
    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const scope = this.#scope(sessionId);
      const key = this.#sourceKey(scope, assetId);
      const source = this.sources.get(key)?.value;
      const blob = this.blobs.get(key);
      if (!source || !blob) return null;
      let bytes;
      if (blob.buffer) {
        bytes = Buffer.from(blob.buffer);
      } else {
        try {
          bytes = await fs.readFile(this.#blobPath(sessionId, assetId));
        } catch (error) {
          if (error?.code === 'ENOENT') {
            this.#dropBlob(key);
            return null;
          }
          throw error;
        }
      }
      if (digest(bytes) !== source.imageSha256) {
        this.#dropBlob(key);
        if (this.#isPersistent(sessionId)) await this.#removeFile(this.#blobPath(sessionId, assetId));
        return null;
      }
      blob.touchedAt = this.#now();
      return Buffer.from(bytes);
    });
  }

  async setEvidence(sessionId, assetId, evidence) {
    await this.initialize();
    if (!this.#readableSession(sessionId) || !this.#validAssetId(assetId)) return null;
    const clonedEvidence = cloneJson(evidence, 'evidence');
    if (!validEvidence(clonedEvidence)) throw new TypeError('evidence fields are malformed');
    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const scope = this.#scope(sessionId);
      const key = this.#sourceKey(scope, assetId);
      const current = this.sources.get(key);
      if (!current) return null;
      const record = { ...current.value, evidence: clonedEvidence, updatedAt: this.#now() };
      const wrapper = this.#sourceWrapper(sessionId, record);
      const metadataBytes = encodedJson(wrapper, 'source');
      if (this.#isPersistent(sessionId)) await this.#writeAtomic(this.#sourcePath(sessionId, assetId), metadataBytes);
      this.sources.set(key, { ...current, updatedAt: record.updatedAt, value: record });
      await this.#pruneEntries();
      return cloneJson(record, 'source');
    });
  }

  async saveRecovery(sessionId, recovery) {
    await this.initialize();
    const publicSession = this.#writeSession(sessionId);
    if (!isPlainObject(recovery) || !validRecoveryId(recovery.id)) {
      throw new TypeError('recovery.id must be a non-empty bounded string');
    }
    const value = cloneJson(recovery, 'recovery');
    if (!validRecoveryRecord(value)) throw new TypeError('recovery fields are malformed');
    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const updatedAt = this.#now();
      const wrapper = this.#recoveryWrapper(publicSession, value, updatedAt);
      const metadataBytes = encodedJson(wrapper, 'recovery');
      if (this.#isPersistent(publicSession)) {
        await this.#writeAtomic(this.#recoveryPath(publicSession, value.id), metadataBytes);
      }
      const scope = this.#scope(publicSession);
      this.recoveries.set(this.#recoveryKey(scope, value.id), { sessionId: publicSession, scope, updatedAt, value });
      await this.#pruneEntries();
      return cloneJson(value, 'recovery');
    });
  }

  async getRecovery(sessionId, id) {
    await this.initialize();
    if (!this.#readableSession(sessionId) || !validRecoveryId(id)) return null;
    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const entry = this.recoveries.get(this.#recoveryKey(this.#scope(sessionId), id));
      return entry ? cloneJson(entry.value, 'recovery') : null;
    });
  }

  async listRecoveries(sessionId) {
    await this.initialize();
    if (!this.#readableSession(sessionId)) return [];
    return this.#exclusive(async () => {
      await this.#pruneExpired();
      const scope = this.#scope(sessionId);
      return [...this.recoveries.values()]
        .filter((entry) => entry.scope === scope)
        .map((entry) => ({ ...entry, sortId: entry.value.id }))
        .sort(compareNewest)
        .map((entry) => cloneJson(entry.value, 'recovery'));
    });
  }

  async #initializeOnce() {
    if (!this.rootDir) return;
    await fs.mkdir(this.#sessionsPath(), { recursive: true, mode: 0o700 });
    const sessionDirectories = (await this.#directories(this.#sessionsPath()))
      .filter((directory) => /^[a-f0-9]{64}$/.test(path.basename(directory)));
    for (const sessionDirectory of sessionDirectories) {
      await this.#cleanUnexpectedSessionEntries(sessionDirectory);
      const sessionHash = path.basename(sessionDirectory);
      await this.#loadMetadataDirectory(path.join(sessionDirectory, 'sources'), 'source', sessionHash);
      await this.#loadMetadataDirectory(path.join(sessionDirectory, 'recoveries'), 'recovery', sessionHash);
    }
    await this.#pruneExpired();
    await this.#pruneEntries();
    await this.#loadBlobs(sessionDirectories);
    await this.#pruneBlobs();
    for (const sessionDirectory of sessionDirectories) await this.#cleanupEmptySessionPath(sessionDirectory);
  }

  async #loadMetadataDirectory(directory, kind, sessionHash) {
    if (!await this.#prepareOwnedDirectory(directory)) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        await this.#removeArtifact(filename);
        continue;
      }
      try {
        const stat = await fs.stat(filename);
        if (stat.size > MAX_METADATA_BYTES) {
          await this.#removeFile(filename);
          continue;
        }
        const parsed = JSON.parse(await fs.readFile(filename, 'utf8'));
        const accepted = kind === 'source'
          ? this.#acceptSourceWrapper(parsed, entry.name, sessionHash)
          : this.#acceptRecoveryWrapper(parsed, entry.name, sessionHash);
        if (!accepted) await this.#removeFile(filename);
      } catch (error) {
        if (error instanceof SyntaxError) {
          await this.#removeFile(filename);
          continue;
        }
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  #acceptSourceWrapper(wrapper, filename, sessionHash) {
    if (!isPlainObject(wrapper) || wrapper.version !== FORMAT_VERSION || wrapper.kind !== 'source') return false;
    if (!validSessionId(wrapper.sessionId) || digest(`session\n${wrapper.sessionId}`) !== sessionHash) return false;
    const record = wrapper.value;
    if (!validSourceRecord(record)) return false;
    if (filename !== `${record.assetId}.json`) return false;
    const scope = this.#scope(wrapper.sessionId);
    if (record.assetId !== this.#assetId(scope, record.imageSha256)) return false;
    this.sources.set(this.#sourceKey(scope, record.assetId), {
      sessionId: wrapper.sessionId,
      scope,
      updatedAt: record.updatedAt,
      value: cloneJson(record, 'source')
    });
    return true;
  }

  #acceptRecoveryWrapper(wrapper, filename, sessionHash) {
    if (!isPlainObject(wrapper) || wrapper.version !== FORMAT_VERSION || wrapper.kind !== 'recovery') return false;
    if (!validSessionId(wrapper.sessionId) || digest(`session\n${wrapper.sessionId}`) !== sessionHash) return false;
    if (!validRecoveryRecord(wrapper.value)) return false;
    if (filename !== `${digest(`recovery\n${wrapper.value.id}`)}.json`) return false;
    if (typeof wrapper.updatedAt !== 'number' || !Number.isFinite(wrapper.updatedAt)) return false;
    const scope = this.#scope(wrapper.sessionId);
    this.recoveries.set(this.#recoveryKey(scope, wrapper.value.id), {
      sessionId: wrapper.sessionId,
      scope,
      updatedAt: wrapper.updatedAt,
      value: cloneJson(wrapper.value, 'recovery')
    });
    return true;
  }

  async #loadBlobs(sessionDirectories) {
    const expected = new Map();
    for (const [key, entry] of this.sources) {
      expected.set(this.#blobPath(entry.sessionId, entry.value.assetId), { key, entry });
    }
    for (const sessionDirectory of sessionDirectories) {
      const blobDirectory = path.join(sessionDirectory, 'blobs');
      if (!await this.#prepareOwnedDirectory(blobDirectory)) continue;
      let entries;
      try {
        entries = await fs.readdir(blobDirectory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        const filename = path.join(blobDirectory, entry.name);
        const match = expected.get(filename);
        if (!entry.isFile() || !match) {
          await this.#removeArtifact(filename);
          continue;
        }
        const stat = await fs.stat(filename);
        this.#setBlob(match.key, {
          sessionId: match.entry.sessionId,
          scope: match.entry.scope,
          assetId: match.entry.value.assetId,
          size: stat.size,
          touchedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : match.entry.updatedAt,
          buffer: null
        });
      }
    }
  }

  async #pruneExpired() {
    if (this.retentionMs <= 0) return;
    const cutoff = this.#now() - this.retentionMs;
    for (const [key, entry] of [...this.sources]) {
      if (entry.updatedAt < cutoff) await this.#removeSource(key, entry);
    }
    for (const [key, entry] of [...this.recoveries]) {
      if (entry.updatedAt < cutoff) await this.#removeRecovery(key, entry);
    }
  }

  async #pruneEntries() {
    while (this.sources.size + this.recoveries.size > this.maxEntries) {
      let oldest = null;
      for (const [key, entry] of this.sources) {
        if (!oldest || entry.updatedAt < oldest.entry.updatedAt) oldest = { kind: 'source', key, entry };
      }
      for (const [key, entry] of this.recoveries) {
        if (!oldest || entry.updatedAt < oldest.entry.updatedAt) oldest = { kind: 'recovery', key, entry };
      }
      if (!oldest) return;
      if (oldest.kind === 'source') await this.#removeSource(oldest.key, oldest.entry);
      else await this.#removeRecovery(oldest.key, oldest.entry);
    }
  }

  async #pruneBlobs() {
    while (this.blobBytes > this.maxBytes) {
      let oldest = null;
      for (const [key, entry] of this.blobs) {
        if (!oldest || entry.touchedAt < oldest.entry.touchedAt) oldest = { key, entry };
      }
      if (!oldest) return;
      this.#dropBlob(oldest.key);
      if (this.#isPersistent(oldest.entry.sessionId)) {
        await this.#removeFile(this.#blobPath(oldest.entry.sessionId, oldest.entry.assetId));
        await this.#cleanupEmptySession(oldest.entry.sessionId);
      }
    }
  }

  async #removeSource(key, entry) {
    this.sources.delete(key);
    this.#dropBlob(key);
    if (!this.#isPersistent(entry.sessionId)) return;
    await this.#removeFile(this.#sourcePath(entry.sessionId, entry.value.assetId));
    await this.#removeFile(this.#blobPath(entry.sessionId, entry.value.assetId));
    await this.#cleanupEmptySession(entry.sessionId);
  }

  async #removeRecovery(key, entry) {
    this.recoveries.delete(key);
    if (this.#isPersistent(entry.sessionId)) {
      await this.#removeFile(this.#recoveryPath(entry.sessionId, entry.value.id));
      await this.#cleanupEmptySession(entry.sessionId);
    }
  }

  #setBlob(key, blob) {
    this.#dropBlob(key);
    this.blobs.set(key, blob);
    this.blobBytes += blob.size;
  }

  #dropBlob(key) {
    const previous = this.blobs.get(key);
    if (!previous) return;
    this.blobs.delete(key);
    this.blobBytes -= previous.size;
  }

  #sourceWrapper(sessionId, record) {
    return { version: FORMAT_VERSION, kind: 'source', sessionId, value: record };
  }

  #recoveryWrapper(sessionId, value, updatedAt) {
    return { version: FORMAT_VERSION, kind: 'recovery', sessionId, updatedAt, value };
  }

  #assetId(scope, imageSha256) {
    return `vra_${digest(`vcc-visual-recovery-v1\n${scope}\n${imageSha256}`, 'base64url')}`;
  }

  #validAssetId(assetId) {
    return typeof assetId === 'string' && ASSET_ID_PATTERN.test(assetId);
  }

  #writeSession(sessionId) {
    if (typeof sessionId !== 'string') throw new TypeError('sessionId must be a string');
    if (sessionId.length > 4096) throw new RangeError('sessionId is too large');
    return sessionId;
  }

  #readableSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.length <= 4096;
  }

  #scope(sessionId) {
    return sessionId.length > 0 ? sessionId : this.anonymousScope;
  }

  #isPersistent(sessionId) {
    return Boolean(this.rootDir && sessionId.length > 0);
  }

  #sourceKey(scope, assetId) {
    return `${digest(`session\n${scope}`)}:${assetId}`;
  }

  #recoveryKey(scope, id) {
    return `${digest(`session\n${scope}`)}:${digest(`recovery\n${id}`)}`;
  }

  #sessionPath(sessionId) {
    return path.join(this.#sessionsPath(), digest(`session\n${sessionId}`));
  }

  #sessionsPath() {
    return path.join(this.rootDir, 'sessions');
  }

  #sourcePath(sessionId, assetId) {
    return path.join(this.#sessionPath(sessionId), 'sources', `${assetId}.json`);
  }

  #blobPath(sessionId, assetId) {
    return path.join(this.#sessionPath(sessionId), 'blobs', `${assetId}.blob`);
  }

  #recoveryPath(sessionId, id) {
    return path.join(this.#sessionPath(sessionId), 'recoveries', `${digest(`recovery\n${id}`)}.json`);
  }

  async #writeAtomic(filename, contents) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
    } catch (error) {
      try {
        await fs.unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
      }
      throw error;
    }
  }

  async #removeFile(filename) {
    try {
      await fs.unlink(filename);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async #removeArtifact(filename) {
    try {
      await fs.rm(filename, { recursive: true, force: false });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async #prepareOwnedDirectory(directory) {
    let stat;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) return true;
    await this.#removeArtifact(directory);
    return false;
  }

  async #cleanUnexpectedSessionEntries(sessionDirectory) {
    const entries = await fs.readdir(sessionDirectory, { withFileTypes: true });
    const ownedNames = new Set(['sources', 'recoveries', 'blobs']);
    for (const entry of entries) {
      if (!ownedNames.has(entry.name)) await this.#removeArtifact(path.join(sessionDirectory, entry.name));
    }
  }

  async #cleanupEmptySession(sessionId) {
    if (!this.#isPersistent(sessionId)) return;
    await this.#cleanupEmptySessionPath(this.#sessionPath(sessionId));
  }

  async #cleanupEmptySessionPath(sessionDirectory) {
    for (const name of ['sources', 'recoveries', 'blobs']) {
      await this.#removeEmptyDirectory(path.join(sessionDirectory, name));
    }
    await this.#removeEmptyDirectory(sessionDirectory);
  }

  async #removeEmptyDirectory(directory) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
    }
  }

  async #directories(parent) {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name));
  }

  #now() {
    const value = Number(this.clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  #exclusive(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }
}
