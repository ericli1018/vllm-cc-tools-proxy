const BUSY_503_PATTERN = /(?:\bbusy\b|overload(?:ed)?|capacity|too many requests|no available (?:slot|capacity|worker)|temporar(?:y|ily) unavailable|server (?:is )?full|max[-_ ]?num[-_ ]?seq)/i;

function responseText(payloadText = '') {
  let message = String(payloadText || '');
  try {
    const payload = message ? JSON.parse(message) : null;
    message = [payload?.error?.type, payload?.error?.code, payload?.error?.message, payload?.message]
      .filter(Boolean)
      .join(' ');
  } catch {}
  return message;
}

export function isExplicitVllmBusyResponse(response, payloadText = '') {
  const status = Number(response?.status || 0);
  if (status === 429) return true;
  if (status !== 503) return false;
  if (response?.headers?.get?.('retry-after')) return true;
  return BUSY_503_PATTERN.test(responseText(payloadText));
}

export function waitForRetry(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, Number(ms) || 0));
    const onAbort = () => done(signal.reason instanceof Error ? signal.reason : new DOMException('Request aborted.', 'AbortError'));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
