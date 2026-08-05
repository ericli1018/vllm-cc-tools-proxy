function abortError(reason) {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

export class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Semaphore limit must be a positive integer');
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.#releaseFactory());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.waiting.push(entry);
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
      if (entry.signal?.aborted) {
        entry.reject(abortError(entry.signal.reason));
        continue;
      }
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      this.active += 1;
      entry.resolve(this.#releaseFactory());
    }
  }

  health() {
    return { active: this.active, limit: this.limit, queued: this.waiting.length };
  }
}
