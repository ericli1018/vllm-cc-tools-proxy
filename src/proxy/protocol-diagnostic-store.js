import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 'vcc-protocol-diagnostic-v1';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeComponent(value, fallback = 'unknown') {
  const safe = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 120);
  return safe || fallback;
}

function timestampComponent(date) {
  return date.toISOString().replace(/[-:]/g, '');
}

function normalizedRound(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(99, parsed));
}

export class ProtocolDiagnosticStore {
  constructor({
    rootDir,
    now = () => new Date(),
    randomId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8),
    fsImpl = fs,
  } = {}) {
    if (!rootDir) throw new TypeError('ProtocolDiagnosticStore rootDir is required');
    this.rootDir = path.resolve(rootDir);
    this.now = now;
    this.randomId = randomId;
    this.fs = fsImpl;
  }

  async write(bundle = {}) {
    const createdAt = this.now();
    const round = normalizedRound(bundle.round);
    const requestId = safeComponent(bundle.request_id, 'request');
    const phase = bundle.repair ? 'repair' : 'original';
    const nonce = safeComponent(this.randomId(), 'nonce').slice(0, 24);
    const filename = `${timestampComponent(createdAt)}__${requestId}__r${String(round).padStart(2, '0')}__${phase}__${nonce}.json`;
    const target = path.join(this.rootDir, filename);
    const temporary = path.join(this.rootDir, `.tmp-${filename}-${crypto.randomUUID()}`);
    const payload = {
      schema_version: SCHEMA_VERSION,
      created_at: createdAt.toISOString(),
      request_id: String(bundle.request_id ?? ''),
      round,
      repair: Boolean(bundle.repair),
      phase: bundle.repair ? 'repair_response' : 'original_response',
      reasons: Array.isArray(bundle.reasons) ? bundle.reasons : [],
      response: bundle.response && typeof bundle.response === 'object' ? bundle.response : {},
      output_snippets: Array.isArray(bundle.output_snippets) ? bundle.output_snippets : [],
      input_snippets: Array.isArray(bundle.input_snippets) ? bundle.input_snippets : [],
    };
    const raw = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    await this.fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.fs.chmod(this.rootDir, 0o700).catch(() => {});
    try {
      await this.fs.writeFile(temporary, raw, { mode: 0o600, flag: 'wx' });
      await this.fs.rename(temporary, target);
      await this.fs.chmod(target, 0o600).catch(() => {});
    } catch (error) {
      await this.fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }

    return {
      file_path: target,
      file_bytes: raw.length,
      file_sha256: sha256(raw),
      created_at: createdAt.toISOString(),
    };
  }
}
