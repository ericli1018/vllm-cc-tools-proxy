import http from 'node:http';
import { Readable } from 'node:stream';
import { HttpError, readJsonBody, sendError, sendJson } from '../lib/http.js';
import { countAdaptableMedia, adaptMessages } from '../proxy/content-blocks.js';
import { stripProgressHistory, ProgressStream } from '../proxy/progress.js';
import { createMediaAdapters } from '../proxy/media-adapters.js';
import { executeManagedTool, isManagedToolName } from '../proxy/web-tools.js';
import { runManagedLoop } from '../proxy/managed-loop.js';
import { emitFinalAnthropicResponse, emitSseError } from '../proxy/anthropic-sse.js';

function upstreamEndpoint(baseUrl, path) {
  const base = new URL(baseUrl);
  const clean = base.pathname.replace(/\/$/, '');
  if (clean.endsWith('/v1/messages')) {
    base.pathname = path === '/v1/messages' ? clean : clean.replace(/\/messages$/, '/messages/count_tokens');
  } else if (clean.endsWith('/v1')) {
    base.pathname = `${clean}${path.replace('/v1', '')}`;
  } else {
    base.pathname = `${clean}${path}`.replace(/\/+/g, '/');
  }
  return base.toString();
}

function upstreamHeaders(incomingHeaders, config) {
  const headers = { 'content-type': 'application/json' };
  for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta']) {
    const value = incomingHeaders?.[name];
    if (typeof value === 'string' && value) headers[name] = value;
  }
  if (config.vllmBaseApiKey) headers.authorization = `Bearer ${config.vllmBaseApiKey}`;
  return headers;
}

async function callUpstreamJson(request, config, incomingHeaders, signal, path = '/v1/messages') {
  let response;
  try {
    response = await fetch(upstreamEndpoint(config.vllmBaseUrl, path), {
      method: 'POST',
      headers: upstreamHeaders(incomingHeaders, config),
      body: JSON.stringify({ ...request, stream: false }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new HttpError(502, 'vLLM upstream is unavailable.', { code: 'vllm_unavailable', retryable: true });
  }
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch {
    throw new HttpError(502, 'vLLM returned invalid JSON.', { code: 'vllm_invalid_response', retryable: true });
  }
  if (!response.ok) {
    throw new HttpError(response.status >= 500 ? 502 : response.status, payload?.error?.message || 'vLLM rejected the request.', {
      code: payload?.error?.type || 'vllm_request_failed',
      retryable: response.status >= 500,
      details: payload?.error,
    });
  }
  return payload;
}

async function passthroughStream(res, request, config, incomingHeaders, signal) {
  let upstream;
  try {
    upstream = await fetch(upstreamEndpoint(config.vllmBaseUrl, '/v1/messages'), {
      method: 'POST',
      headers: upstreamHeaders(incomingHeaders, config),
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new HttpError(502, 'vLLM upstream is unavailable.', { code: 'vllm_unavailable', retryable: true });
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    throw new HttpError(upstream.status >= 500 ? 502 : upstream.status, text || 'vLLM rejected the request.', {
      code: 'vllm_request_failed', retryable: upstream.status >= 500,
    });
  }
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (!upstream.body) return res.end();
  await new Promise((resolve, reject) => {
    const source = Readable.fromWeb(upstream.body);
    source.on('error', reject);
    res.on('error', reject);
    res.on('finish', resolve);
    source.pipe(res);
  });
}

function hasManagedDefinitions(request) {
  return Array.isArray(request.tools) && request.tools.some((tool) => isManagedToolName(tool?.name));
}

function validateMessagesRequest(request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages)) {
    throw new HttpError(400, 'Anthropic Messages request requires a messages array.', { code: 'invalid_request' });
  }
}

function log(config, level, event, fields = {}) {
  const ranks = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((ranks[level] || 20) < (ranks[config.logLevel] || 20)) return;
  const payload = { timestamp: new Date().toISOString(), level, event, ...fields };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

export function createProxyServer(config) {
  return http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    const abortController = new AbortController();
    let progress = null;
    let completed = false;
    res.on('close', () => {
      if (!completed && !abortController.signal.aborted) {
        abortController.abort(new Error('client disconnected'));
        log(config, 'info', 'client_disconnect_detected', { requestId });
      }
    });

    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        completed = true;
        return sendJson(res, 200, { status: 'ok', service: 'proxy', version: '0.2.1', revision: config.gitRevision });
      }
      if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) {
        throw new HttpError(404, 'Endpoint not found.', { code: 'not_found' });
      }

      const original = await readJsonBody(req, config.limits.maxRequestBytes);
      validateMessagesRequest(original);
      const request = { ...original, messages: stripProgressHistory(original.messages) };
      const mediaCount = countAdaptableMedia(request.messages);
      const hasMedia = mediaCount.documents + mediaCount.images > 0;
      const managed = hasManagedDefinitions(request);

      if (url.pathname === '/v1/messages/count_tokens') {
        const adapters = createMediaAdapters(config, abortController.signal);
        request.messages = await adaptMessages(request.messages, adapters);
        const payload = await callUpstreamJson(request, config, req.headers, abortController.signal, url.pathname);
        completed = true;
        return sendJson(res, 200, payload);
      }

      if (request.stream === true && !hasMedia && !managed) {
        await passthroughStream(res, request, config, req.headers, abortController.signal);
        completed = true;
        return;
      }

      const onProgress = async (message, details = {}) => {
        log(config, 'info', 'managed_task_progress', { requestId, message, ...details });
        await progress?.update(message);
      };

      if (request.stream === true) {
        progress = new ProgressStream(res, {
          model: request.model || 'vllm',
          pingIntervalMs: config.progressPingIntervalMs,
          visibleAfterMs: config.progressVisibleAfterMs,
        });
        await progress.open();
      }

      if (hasMedia) {
        const adapters = createMediaAdapters(config, abortController.signal, onProgress);
        request.messages = await adaptMessages(request.messages, adapters);
        await onProgress('文件與圖片內容已就緒；正在交給模型分析…', { phase: 'media_ready' });
      }

      const upstream = (body, signal) => callUpstreamJson(body, config, req.headers, signal);
      const result = managed
        ? await runManagedLoop(request, {
          upstream,
          executeTool: (toolUse, signal) => executeManagedTool(toolUse, config, signal),
          maxRounds: config.maxToolRounds,
          onProgress,
          signal: abortController.signal,
        })
        : await upstream(request, abortController.signal);

      if (request.stream === true) {
        await emitFinalAnthropicResponse(progress, result);
      } else {
        sendJson(res, 200, result);
      }
      completed = true;
      log(config, 'info', 'request_completed', { requestId, hasMedia, managed });
    } catch (error) {
      if (abortController.signal.aborted && res.destroyed) return;
      log(config, 'error', 'request_failed', { requestId, code: error.code || 'internal_error', message: error.message });
      if (progress) await emitSseError(progress, error);
      else if (!res.headersSent) sendError(res, error);
      else res.destroy(error);
      completed = true;
    }
  });
}
