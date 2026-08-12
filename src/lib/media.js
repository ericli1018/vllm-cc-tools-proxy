import { HttpError } from './http.js';

export function estimateDecodedBytes(base64) {
  if (typeof base64 !== 'string') return Number.POSITIVE_INFINITY;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function detectMediaType(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function isBase64AlphabetCode(code) {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

function hasValidBase64AlphabetAndPadding(data) {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const payloadEnd = data.length - padding;
  for (let index = 0; index < payloadEnd; index += 1) {
    if (!isBase64AlphabetCode(data.charCodeAt(index))) return false;
  }
  for (let index = payloadEnd; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

export function decodeBase64Media(data, maxBytes, expectedMediaType) {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0) {
    throw new HttpError(422, 'Media source contains invalid Base64.', { code: 'invalid_base64' });
  }
  const estimated = estimateDecodedBytes(data);
  if (estimated > maxBytes) {
    throw new HttpError(413, 'Decoded media exceeds the configured resource profile.', { code: 'media_too_large' });
  }
  if (!hasValidBase64AlphabetAndPadding(data)) {
    throw new HttpError(422, 'Media source contains invalid Base64.', { code: 'invalid_base64' });
  }
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > maxBytes) {
    throw new HttpError(413, 'Decoded media exceeds the configured resource profile.', { code: 'media_too_large' });
  }
  const detected = detectMediaType(buffer);
  if (!detected || detected !== expectedMediaType) {
    throw new HttpError(422, `Declared media type ${expectedMediaType} does not match decoded content.`, {
      code: 'media_magic_mismatch',
      details: { declared: expectedMediaType, detected: detected || 'unknown' },
    });
  }
  return buffer;
}

export function xmlAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function boundedText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { text, truncated: false, originalChars: text.length };
  return { text: text.slice(0, maxChars), truncated: true, originalChars: text.length };
}

export function serviceEndpoint(baseUrl, defaultPath) {
  if (!baseUrl) return '';
  const url = new URL(baseUrl);
  if (url.pathname === '/' || url.pathname === '') url.pathname = defaultPath;
  return url.toString();
}


function safeTransportCause(error) {
  const rawCode = error?.cause?.code || error?.code || '';
  const code = /^[A-Z0-9_]{2,80}$/.test(String(rawCode)) ? String(rawCode) : '';
  const phases = {
    UND_ERR_HEADERS_TIMEOUT: 'headers',
    UND_ERR_BODY_TIMEOUT: 'body',
    UND_ERR_CONNECT_TIMEOUT: 'connect',
    ECONNREFUSED: 'connect',
    ETIMEDOUT: 'connect',
    ENETUNREACH: 'connect',
    EHOSTUNREACH: 'connect',
    ECONNRESET: 'connection',
    EPIPE: 'connection',
  };
  return { code, phase: phases[code] || 'transport' };
}

function transportFailureMessage(host, transport) {
  if (transport.code === 'UND_ERR_HEADERS_TIMEOUT') return `Service did not return response headers before the HTTP client timeout: ${host}`;
  if (transport.code === 'UND_ERR_BODY_TIMEOUT') return `Service response body did not complete before the HTTP client timeout: ${host}`;
  if (transport.phase === 'connect') return `Unable to connect to service: ${host}`;
  if (transport.phase === 'connection') return `Service connection was interrupted: ${host}`;
  return `Unable to reach service: ${host}`;
}

export async function fetchJson(url, options = {}, { errorCode = 'upstream_service_error' } = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const host = new URL(url).host;
    const transport = safeTransportCause(error);
    throw new HttpError(502, transportFailureMessage(host, transport), {
      code: errorCode,
      retryable: true,
      details: {
        ...(transport.code ? { transport_code: transport.code } : {}),
        transport_phase: transport.phase,
      },
    });
  }
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(502, 'Service returned invalid JSON.', { code: errorCode, retryable: true });
  }
  if (!response.ok) {
    throw new HttpError(response.status >= 500 ? 502 : 422, payload?.error?.message || payload?.message || 'Service rejected the request.', {
      code: payload?.error?.type || errorCode,
      retryable: response.status >= 500,
    });
  }
  return payload;
}
