function abortError(signal) {
  return signal?.reason || new DOMException('The operation was aborted.', 'AbortError');
}

export class MediaAnalysisRegistry {
  constructor({ onEvent = () => {} } = {}) {
    this.inflight = new Map();
    this.onEvent = onEvent;
  }

  run(key, producer, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, waiters: 0, settled: false, promise: null };
      entry.promise = Promise.resolve(producer({ signal: controller.signal }))
        .finally(() => {
          entry.settled = true;
          if (this.inflight.get(key) === entry) this.inflight.delete(key);
        });
      entry.promise.catch(() => {});
      this.inflight.set(key, entry);
      this.onEvent('media_singleflight_created', { keyPrefix: key.slice(0, 12) });
    } else {
      this.onEvent('media_singleflight_joined', { keyPrefix: key.slice(0, 12), waiters: entry.waiters + 1 });
    }

    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (entry.waiters === 0 && !entry.settled && !entry.controller.signal.aborted) {
          entry.controller.abort(new DOMException('All media-analysis waiters cancelled.', 'AbortError'));
          this.onEvent('media_singleflight_cancelled', { keyPrefix: key.slice(0, 12) });
        }
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => { if (finish()) resolve(value); },
        (error) => { if (finish()) reject(error); },
      );
    });
  }

  health() { return { inflight_analyses: this.inflight.size }; }
}
