import { once } from 'node:events';

export class HttpError extends Error {
  constructor(status, message, { code = 'request_error', retryable = false, details } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export async function readBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limitBytes) {
      throw new HttpError(413, 'Request body exceeds the configured resource profile.', {
        code: 'request_too_large',
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export async function readJsonBody(req, limitBytes) {
  const body = await readBody(req, limitBytes);
  if (body.length === 0) {
    throw new HttpError(400, 'Request body is required.', { code: 'invalid_request' });
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.', { code: 'invalid_json' });
  }
}

export function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendError(res, error) {
  const normalized = error instanceof HttpError
    ? error
    : new HttpError(500, 'Internal proxy error.', { code: 'internal_error', retryable: false });
  sendJson(res, normalized.status, {
    type: 'error',
    error: {
      type: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  });
}

export async function writeChunk(res, chunk) {
  if (!res.write(chunk)) await once(res, 'drain');
}

export function requestUrl(req, base = 'http://localhost') {
  return new URL(req.url || '/', base);
}
