import http from 'node:http';
import https from 'node:https';
import { HttpError } from '../lib/http.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

export function buildUpstreamUrl(baseUrl, incomingUrl) {
  const base = new URL(baseUrl);
  const incoming = new URL(incomingUrl || '/', 'http://proxy.local');
  let basePath = base.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/v1/messages')) basePath = basePath.slice(0, -'/v1/messages'.length);

  if (basePath.endsWith('/v1') && (incoming.pathname === '/v1' || incoming.pathname.startsWith('/v1/'))) {
    base.pathname = `${basePath}${incoming.pathname.slice(3)}` || '/v1';
  } else {
    base.pathname = `${basePath}/${incoming.pathname.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  }
  base.search = incoming.search;
  base.hash = '';
  return base.toString();
}

export function filterRequestHeaders(incomingHeaders = {}, apiKey = '') {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(incomingHeaders)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || name === 'content-length' || rawValue === undefined) continue;
    headers[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function filterResponseHeaders(headers = {}) {
  const output = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    output[name] = value;
  }
  return output;
}

export async function forwardTransparent(req, res, config, { rawBody = Buffer.alloc(0), signal } = {}) {
  const target = new URL(buildUpstreamUrl(config.vllmBaseUrl, req.url || '/'));
  const transport = target.protocol === 'https:' ? https : http;
  const headers = filterRequestHeaders(req.headers, config.vllmBaseApiKey);
  if (rawBody.length > 0) headers['content-length'] = String(rawBody.length);

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const upstreamReq = transport.request(target, {
      method: req.method,
      headers,
    }, (upstreamRes) => {
      if (!res.headersSent) {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, filterResponseHeaders(upstreamRes.headers));
      }
      upstreamRes.on('error', finish);
      res.on('error', finish);
      res.on('finish', () => finish());
      upstreamRes.pipe(res);
    });
    const onAbort = () => upstreamReq.destroy(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    upstreamReq.on('error', (error) => {
      if (error?.name === 'AbortError' || signal?.aborted) return finish(error);
      finish(new HttpError(502, 'Base vLLM bypass upstream is unavailable.', {
        code: 'vllm_unavailable', retryable: true, details: error.message,
      }));
    });
    if (rawBody.length > 0 && req.method !== 'GET' && req.method !== 'HEAD') upstreamReq.write(rawBody);
    upstreamReq.end();
  });
}
