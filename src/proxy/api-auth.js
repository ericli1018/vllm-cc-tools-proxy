import { createHash, timingSafeEqual } from 'node:crypto';

const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization']);
const MAX_KEY_BYTES = 512;
const keyIsValid = value => typeof value === 'string' && value.length > 0
  && value.length <= MAX_KEY_BYTES && /^[\x21-\x7e]+$/.test(value) && !value.includes(',');

// Do not echo a misconfigured secret in startup errors.
export function validateProxyApiKey(value, { required = false } = {}) {
  if (value === '' && !required) return;
  if (!keyIsValid(value)) {
    throw new Error('PROXY_API_KEY must contain 1-512 visible ASCII characters without whitespace or commas when authentication is enabled.');
  }
}

function credentialValues(req) {
  const values = { authorization: [], 'x-api-key': [] };
  if (Array.isArray(req.rawHeaders)) {
    // Node can discard or join duplicate headers in req.headers. Inspect wire
    // occurrences instead so two Authorization headers cannot select a winner.
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = String(req.rawHeaders[i]).toLowerCase();
      if (Object.hasOwn(values, name)) values[name].push(req.rawHeaders[i + 1]);
    }
  } else {
    for (const [name, value] of Object.entries(req.headers || {})) {
      const lower = name.toLowerCase();
      if (Object.hasOwn(values, lower)) values[lower].push(...(Array.isArray(value) ? value : [value]));
    }
  }
  return values;
}

export function createProxyAuthenticator(config) {
  if (!config.proxyAuthEnabled) return () => true;
  validateProxyApiKey(config.proxyApiKey, { required: true });
  const digest = value => createHash('sha256').update(value, 'utf8').digest();
  const expected = digest(config.proxyApiKey);
  return req => {
    const values = credentialValues(req);
    const auth = values.authorization;
    const api = values['x-api-key'];
    if (auth.length > 1 || api.length > 1 || auth.length + api.length === 0) return false;
    const candidates = [];
    if (auth.length) {
      const match = typeof auth[0] === 'string' && /^Bearer[\t ]+([^\s,]+)$/i.exec(auth[0]);
      if (!match || !keyIsValid(match[1])) return false;
      candidates.push(match[1]);
    }
    if (api.length) {
      if (!keyIsValid(api[0])) return false;
      candidates.push(api[0]);
    }
    // Fixed-length digests avoid leaking the configured key length or throwing
    // for unequal lengths. Evaluate both headers even if the first mismatches.
    let matches = 1;
    for (const value of candidates) matches &= Number(timingSafeEqual(expected, digest(value)));
    return matches === 1;
  };
}

export function isPublicHealthRequest(req) {
  if (req.method !== 'GET') return false;
  try {
    const path = new URL(req.url || '/', 'http://proxy.local').pathname;
    return path === '/health' || path === '/healthz';
  } catch {
    return false;
  }
}

export function stripProxyCredentials(req) {
  for (const name of Object.keys(req.headers || {})) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) delete req.headers[name];
  }
  if (Array.isArray(req.rawHeaders)) {
    const filtered = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!CREDENTIAL_HEADERS.has(String(req.rawHeaders[i]).toLowerCase())) filtered.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    req.rawHeaders = filtered;
  }
}
