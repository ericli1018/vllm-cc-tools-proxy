import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY_PATTERN = /^[a-f0-9]{64}$/;
const CACHE_VERSION = 1;

function cacheFileName(key) { return `${key}.json`; }
function isCapacityError(error) { return ['ENOSPC', 'EDQUOT'].includes(error?.code); }

export class MediaCache {
  constructor({
    rootDir,
    maxBytes = 0,
    retentionMs = 7 * 24 * 60 * 60 * 1000,
    clock = () => Date.now(),
    fsImpl = fs,
  } = {}) {
    this.rootDir = rootDir;
    this.maxBytes = maxBytes;
    this.retentionMs = retentionMs;
    this.clock = clock;
    this.fs = fsImpl;
    this.index = new Map();
    this.memory = new Map();
    this.bytes = 0;
    this.writeAvailable = true;
    this.lastError = '';
    this.operation = Promise.resolve();
  }

  async initialize() {
    if (!this.rootDir) return this;
    await this.fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const names = await this.fs.readdir(this.rootDir).catch(() => []);
    for (const name of names) {
      const filePath = path.join(this.rootDir, name);
      if (name.startsWith('.tmp-')) {
        await this.fs.rm(filePath, { force: true }).catch(() => {});
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -5);
      if (!KEY_PATTERN.test(key)) {
        await this.fs.rm(filePath, { force: true }).catch(() => {});
        continue;
      }
      try {
        const raw = await this.fs.readFile(filePath);
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed.version !== CACHE_VERSION || parsed.key !== key || !parsed.value) throw new Error('invalid cache entry');
        const lastUsedAt = Number(parsed.lastUsedAt || parsed.createdAt || 0);
        if (this.#expired(lastUsedAt)) {
          await this.fs.rm(filePath, { force: true });
          continue;
        }
        this.index.set(key, { filePath, size: raw.length, lastUsedAt, createdAt: Number(parsed.createdAt || lastUsedAt) });
        this.bytes += raw.length;
      } catch {
        await this.fs.rm(filePath, { force: true }).catch(() => {});
      }
    }
    await this.#evictToLimit();
    return this;
  }

  #run(operation) {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => {});
    return next;
  }

  #entryPath(key) {
    if (!KEY_PATTERN.test(key)) throw new TypeError('cache key must be a 64-character lowercase SHA-256 hex string');
    return path.join(this.rootDir, cacheFileName(key));
  }

  #expired(lastUsedAt) {
    return this.retentionMs > 0 && this.clock() - lastUsedAt > this.retentionMs;
  }

  async #removeEntry(key) {
    const entry = this.index.get(key);
    if (!entry) return;
    this.index.delete(key);
    this.bytes = Math.max(0, this.bytes - entry.size);
    await this.fs.rm(entry.filePath, { force: true }).catch(() => {});
  }

  async #writeAtomic(key, payload) {
    const target = this.#entryPath(key);
    const temporary = path.join(this.rootDir, `.tmp-${key}-${crypto.randomUUID()}`);
    const raw = Buffer.from(`${JSON.stringify(payload)}\n`);
    try {
      await this.fs.writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
      await this.fs.rename(temporary, target);
      return { target, size: raw.length };
    } catch (error) {
      await this.fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #evictToLimit() {
    if (this.maxBytes === 0 || this.bytes <= this.maxBytes) return;
    const candidates = [...this.index.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key] of candidates) {
      if (this.bytes <= this.maxBytes) break;
      await this.#removeEntry(key);
    }
  }

  async #removeExpiredEntries() {
    if (this.retentionMs <= 0) return;
    for (const [key, entry] of [...this.index.entries()]) {
      if (this.#expired(entry.lastUsedAt)) await this.#removeEntry(key);
    }
  }

  #evictMemoryToLimit() {
    if (this.maxBytes === 0 || this.bytes <= this.maxBytes) return;
    const candidates = [...this.memory.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of candidates) {
      if (this.bytes <= this.maxBytes) break;
      this.memory.delete(key);
      this.bytes = Math.max(0, this.bytes - entry.size);
    }
  }

  async get(key) {
    return this.#run(async () => {
      if (!this.rootDir) {
        const entry = this.memory.get(key);
        if (!entry) return null;
        if (this.#expired(entry.lastUsedAt)) {
          this.memory.delete(key);
          this.bytes = Math.max(0, this.bytes - entry.size);
          return null;
        }
        entry.lastUsedAt = this.clock();
        return structuredClone(entry.value);
      }
      const entry = this.index.get(key);
      if (!entry) return null;
      if (this.#expired(entry.lastUsedAt)) {
        await this.#removeEntry(key);
        return null;
      }
      try {
        const raw = await this.fs.readFile(entry.filePath);
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed.version !== CACHE_VERSION || parsed.key !== key || !parsed.value) throw new Error('invalid cache entry');
        const now = this.clock();
        parsed.lastUsedAt = now;
        try {
          const written = await this.#writeAtomic(key, parsed);
          this.bytes += written.size - entry.size;
          this.index.set(key, { ...entry, filePath: written.target, size: written.size, lastUsedAt: now });
          this.writeAvailable = true;
          this.lastError = '';
        } catch (error) {
          if (isCapacityError(error)) {
            this.writeAvailable = false;
            this.lastError = error.code;
          }
          entry.lastUsedAt = now;
        }
        return structuredClone(parsed.value);
      } catch {
        await this.#removeEntry(key);
        return null;
      }
    });
  }

  async set(key, value) {
    return this.#run(async () => {
      const now = this.clock();
      if (!this.rootDir) {
        for (const [memoryKey, memoryEntry] of [...this.memory.entries()]) {
          if (this.#expired(memoryEntry.lastUsedAt)) {
            this.memory.delete(memoryKey);
            this.bytes = Math.max(0, this.bytes - memoryEntry.size);
          }
        }
        const raw = Buffer.from(JSON.stringify(value));
        const existingMemory = this.memory.get(key);
        if (existingMemory) this.bytes -= existingMemory.size;
        this.memory.set(key, { value: structuredClone(value), size: raw.length, createdAt: existingMemory?.createdAt || now, lastUsedAt: now });
        this.bytes += raw.length;
        this.#evictMemoryToLimit();
        return this.memory.has(key);
      }
      await this.#removeExpiredEntries();
      const existing = this.index.get(key);
      const payload = {
        version: CACHE_VERSION,
        key,
        createdAt: existing?.createdAt || now,
        lastUsedAt: now,
        value,
      };
      try {
        const written = await this.#writeAtomic(key, payload);
        if (existing) this.bytes -= existing.size;
        this.bytes += written.size;
        this.index.set(key, { filePath: written.target, size: written.size, lastUsedAt: now, createdAt: payload.createdAt });
        this.writeAvailable = true;
        this.lastError = '';
        await this.#evictToLimit();
        return this.index.has(key);
      } catch (error) {
        if (isCapacityError(error)) {
          this.writeAvailable = false;
          this.lastError = error.code;
          return false;
        }
        this.writeAvailable = false;
        this.lastError = error?.code || 'CACHE_WRITE_FAILED';
        return false;
      }
    });
  }

  async delete(key) {
    return this.#run(async () => {
      if (!this.rootDir) {
        const entry = this.memory.get(key);
        if (entry) this.bytes = Math.max(0, this.bytes - entry.size);
        this.memory.delete(key);
        return;
      }
      await this.#removeEntry(key);
    });
  }

  health() {
    return {
      entries: this.rootDir ? this.index.size : this.memory.size,
      bytes: this.bytes,
      max_bytes: this.maxBytes,
      limit_mode: this.maxBytes === 0 ? 'filesystem' : 'bounded',
      write_available: this.writeAvailable,
      ...(this.lastError ? { last_error: this.lastError } : {}),
    };
  }
}
