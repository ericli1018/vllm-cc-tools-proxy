import { HttpError } from '../lib/http.js';

function abortError(reason) {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

export class ManagedQueue {
  constructor({ limit, queueLimit, timeoutMs }) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Managed queue limit must be a positive integer');
    if (!Number.isInteger(queueLimit) || queueLimit < 0) throw new TypeError('Managed queue capacity must be a non-negative integer');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Managed queue timeout must be a positive integer');
    this.limit = limit;
    this.queueLimit = queueLimit;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.waiting = [];
  }

  acquire({ requestId = '', signal, onPosition } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.#releaseFactory());
    }
    if (this.waiting.length >= this.queueLimit) {
      return Promise.reject(new HttpError(429, 'Proxy managed-task queue is full.', {
        code: 'proxy_queue_full', retryable: true,
      }));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        requestId, signal, onPosition, resolve, reject,
        timer: null, onAbort: null, settled: false, lastPosition: null,
      };
      entry.timer = setTimeout(() => {
        if (!this.#remove(entry)) return;
        entry.settled = true;
        reject(new HttpError(503, 'Proxy managed-task queue wait timed out.', {
          code: 'proxy_queue_timeout', retryable: true,
        }));
        this.#notifyPositions();
      }, this.timeoutMs);
      if (signal) {
        entry.onAbort = () => {
          if (!this.#remove(entry)) return;
          clearTimeout(entry.timer);
          entry.settled = true;
          reject(abortError(signal.reason));
          this.#notifyPositions();
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.waiting.push(entry);
      this.#notifyPositions();
    });
  }

  canAccept() {
    return this.active < this.limit || this.waiting.length < this.queueLimit;
  }

  #remove(entry) {
    const index = this.waiting.indexOf(entry);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    return true;
  }

  #notifyPositions() {
    const snapshot = this.health();
    this.waiting.forEach((entry, index) => {
      const position = index + 1;
      if (entry.lastPosition === position) return;
      entry.lastPosition = position;
      try { entry.onPosition?.(position, snapshot); } catch {}
    });
  }

  #releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.#drain();
    };
  }

  #drain() {
    while (this.active < this.limit && this.waiting.length > 0) {
      const entry = this.waiting.shift();
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(abortError(entry.signal.reason));
        continue;
      }
      entry.settled = true;
      this.active += 1;
      entry.resolve(this.#releaseFactory());
      this.#notifyPositions();
    }
  }

  health() {
    return { active: this.active, limit: this.limit, queued: this.waiting.length, queueLimit: this.queueLimit };
  }
}
