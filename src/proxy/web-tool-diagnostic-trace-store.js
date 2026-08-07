import fs from 'node:fs/promises';
import path from 'node:path';
import { redactDiagnosticText } from './protocol-diagnostics.js';

const SCHEMA_VERSION = 'vcc-web-tool-trace-v1';
const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)$/i;

function safeComponent(value, fallback = 'unknown') {
  const out = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 120);
  return out || fallback;
}

function timestampComponent(date) {
  return date.toISOString().replace(/[-:]/g, '');
}

export function redactWebToolTraceValue(value, key = '', seen = new WeakSet()) {
  if (SECRET_KEY.test(String(key || ''))) return '[REDACTED]';
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactWebToolTraceValue(entry, '', seen));
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    redactWebToolTraceValue(child, childKey, seen),
  ]));
}

export class WebToolDiagnosticTraceStore {
  constructor({
    rootDir,
    now = () => new Date(),
    sessionId = `pid-${process.pid}-${Date.now()}`,
    fsImpl = fs,
  } = {}) {
    if (!rootDir) throw new TypeError('WebToolDiagnosticTraceStore rootDir is required');
    this.rootDir = path.resolve(rootDir);
    this.now = now;
    this.sessionId = safeComponent(sessionId, 'session');
    this.fs = fsImpl;
    this.sequence = 0;
    this.queue = Promise.resolve();
  }

  async write(event = {}) {
    const task = async () => {
      const createdAt = this.now();
      const sequence = ++this.sequence;
      const requestId = safeComponent(event.request_id, 'request');
      const eventName = safeComponent(event.event, 'event');
      const sessionDir = path.join(this.rootDir, this.sessionId);
      const filename = `${String(sequence).padStart(5, '0')}__${timestampComponent(createdAt)}__${eventName}__${requestId}.json`;
      const target = path.join(sessionDir, filename);
      const temporary = `${target}.tmp`;
      const payload = {
        schema_version: SCHEMA_VERSION,
        created_at: createdAt.toISOString(),
        sequence,
        session_id: this.sessionId,
        request_id: String(event.request_id ?? ''),
        event: String(event.event ?? ''),
        direction: String(event.direction ?? ''),
        metadata: redactWebToolTraceValue(event.metadata ?? {}),
        payload: redactWebToolTraceValue(event.payload ?? {}),
      };
      const raw = `${JSON.stringify(payload, null, 2)}\n`;
      await this.fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await this.fs.chmod(sessionDir, 0o700).catch(() => {});
      await this.fs.writeFile(temporary, raw, { mode: 0o600 });
      await this.fs.rename(temporary, target);
      await this.fs.chmod(target, 0o600).catch(() => {});
      const indexEntry = JSON.stringify({
        sequence,
        created_at: payload.created_at,
        request_id: payload.request_id,
        event: payload.event,
        direction: payload.direction,
        file: filename,
      });
      const indexPath = path.join(sessionDir, 'index.jsonl');
      await this.fs.appendFile(indexPath, `${indexEntry}\n`, { mode: 0o600 });
      await this.fs.chmod(indexPath, 0o600).catch(() => {});
      return { file_path: target, index_path: indexPath, sequence, session_dir: sessionDir };
    };
    const pending = this.queue.then(task, task);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
