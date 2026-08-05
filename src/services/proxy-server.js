import http from 'node:http';
import { HttpError, readBody, sendError, sendJson } from '../lib/http.js';
import { adaptMessages } from '../proxy/content-blocks.js';
import { hasProgressHistory, stripProgressHistory, ProgressStream } from '../proxy/progress.js';
import { createMediaAdapters } from '../proxy/media-adapters.js';
import { executeManagedTool } from '../proxy/web-tools.js';
import { runManagedLoop } from '../proxy/managed-loop.js';
import { emitFinalAnthropicResponse, emitSseError, pipeAnthropicUpstreamStream } from '../proxy/anthropic-sse.js';
import { classifyMessagesRequest } from '../proxy/managed-detector.js';
import { forwardTransparent } from '../proxy/bypass.js';
import { prepareMediaHandles } from '../proxy/media-preflight.js';
import { AdmissionController } from '../concurrency/admission-controller.js';

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

async function fetchUpstream(request, config, incomingHeaders, signal, path = '/v1/messages') {
  let response;
  try {
    response = await fetch(upstreamEndpoint(config.vllmBaseUrl, path), {
      method: 'POST',
      headers: upstreamHeaders(incomingHeaders, config),
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new HttpError(502, 'vLLM upstream is unavailable.', { code: 'vllm_unavailable', retryable: true });
  }
  return response;
}

async function callUpstreamJson(request, config, incomingHeaders, signal, path = '/v1/messages') {
  const response = await fetchUpstream({ ...request, stream: false }, config, incomingHeaders, signal, path);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch {
    throw new HttpError(502, 'vLLM returned invalid JSON.', { code: 'vllm_invalid_response', retryable: true });
  }
  if (!response.ok) {
    throw new HttpError(response.status >= 500 ? 502 : response.status, payload?.error?.message || 'vLLM rejected the request.', {
      code: payload?.error?.type || 'vllm_request_failed', retryable: response.status >= 500, details: payload?.error,
    });
  }
  return payload;
}

async function streamManagedBase(progress, request, config, incomingHeaders, signal) {
  const upstream = await fetchUpstream({ ...request, stream: true }, config, incomingHeaders, signal);
  if (!upstream.ok) {
    const text = await upstream.text();
    throw new HttpError(upstream.status >= 500 ? 502 : upstream.status, text || 'vLLM rejected the request.', {
      code: 'vllm_request_failed', retryable: upstream.status >= 500,
    });
  }
  if (!(upstream.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
    const text = await upstream.text();
    throw new HttpError(502, 'vLLM did not return an Anthropic SSE stream.', {
      code: 'vllm_invalid_stream', retryable: true, details: text.slice(0, 1000),
    });
  }
  await pipeAnthropicUpstreamStream(progress, upstream);
}

function parseJson(rawBody) {
  if (!rawBody.length) return null;
  try { return JSON.parse(rawBody.toString('utf8')); } catch { return null; }
}

function validateMessagesRequest(request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages)) {
    throw new HttpError(400, 'Anthropic Messages request requires a messages array.', { code: 'invalid_request' });
  }
}

function canonicalMessagesPath(pathname) {
  if (pathname === '/v1/messages' || pathname === '/v1/messages/') return '/v1/messages';
  if (pathname === '/v1/messages/count_tokens' || pathname === '/v1/messages/count_tokens/') return '/v1/messages/count_tokens';
  return '';
}

function log(config, level, event, fields = {}) {
  const ranks = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((ranks[level] || 20) < (ranks[config.logLevel] || 20)) return;
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}

function defaultConcurrency(config) {
  return config.concurrency || { managedLimit: 2, queueLimit: 12, queueTimeoutMs: 120000, visionLimit: 1 };
}

export function createProxyServer(config, dependencies = {}) {
  const admission = dependencies.admission || new AdmissionController(defaultConcurrency(config));

  return http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    const abortController = new AbortController();
    let progress = null;
    let completed = false;
    let releaseManaged = null;
    let releaseIngress = null;
    let preparedMedia = null;
    const url = new URL(req.url || '/', 'http://localhost');

    res.on('close', () => {
      if (!completed && !abortController.signal.aborted) {
        abortController.abort(new DOMException('Client disconnected.', 'AbortError'));
        log(config, 'info', 'client_disconnect_detected', { requestId, method: req.method, path: url.pathname });
      }
    });

    try {
      if (req.method === 'HEAD' && url.pathname === '/') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        completed = true;
        log(config, 'debug', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'local', reason: 'startup_probe' });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        const state = admission.health();
        completed = true;
        return sendJson(res, 200, {
          status: 'ok', service: 'proxy', version: '0.2.3', revision: config.gitRevision,
          managed: { active: state.managed.active, limit: state.managed.limit, queued: state.managed.queued, queue_limit: state.managed.queueLimit },
          vision: { active: state.vision.active, limit: state.vision.limit },
        });
      }

      const messagesPath = req.method === 'POST' ? canonicalMessagesPath(url.pathname) : '';
      const isMessagesPath = Boolean(messagesPath);
      if (!isMessagesPath) {
        releaseIngress = await admission.acquireIngress({ signal: abortController.signal });
        const rawBody = await readBody(req, config.limits.maxRequestBytes);
        releaseIngress(); releaseIngress = null;
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'unmanaged_endpoint' });
        await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
        completed = true;
        return;
      }

      releaseIngress = await admission.acquireIngress({ signal: abortController.signal });
      let rawBody = await readBody(req, config.limits.maxRequestBytes);
      let original = parseJson(rawBody);
      if (!original) {
        releaseIngress(); releaseIngress = null;
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'invalid_json_passthrough' });
        await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
        completed = true;
        return;
      }

      const classification = classifyMessagesRequest(original);
      const managed = messagesPath === '/v1/messages/count_tokens'
        ? classification.mediaCount.documents + classification.mediaCount.images > 0
        : classification.managed;

      if (!managed) {
        if (hasProgressHistory(original.messages)) {
          original = { ...original, messages: stripProgressHistory(original.messages) };
          rawBody = Buffer.from(JSON.stringify(original));
        }
        releaseIngress(); releaseIngress = null;
        log(config, 'info', 'route_decision', { requestId, method: req.method, path: url.pathname, decision: 'bypass', reason: 'plain_anthropic_request' });
        await forwardTransparent(req, res, config, { rawBody, signal: abortController.signal });
        completed = true;
        return;
      }

      validateMessagesRequest(original);
      if (!admission.canAcceptManaged()) {
        throw new HttpError(429, 'Proxy managed-task queue is full.', { code: 'proxy_queue_full', retryable: true });
      }

      let request = { ...original, messages: stripProgressHistory(original.messages) };
      const hasMedia = classification.mediaCount.documents + classification.mediaCount.images > 0;
      const hasManagedTools = classification.reasons.includes('managed_web_tool') && messagesPath === '/v1/messages';

      if (request.stream === true) {
        progress = new ProgressStream(res, {
          model: request.model || 'vllm',
          pingIntervalMs: config.progressPingIntervalMs,
          visibleAfterMs: config.progressVisibleAfterMs,
        });
        await progress.open();
      }

      const onProgress = async (message, details = {}) => {
        log(config, 'info', 'managed_task_progress', { requestId, message, ...details });
        await progress?.update(message);
      };

      if (hasMedia) {
        await onProgress('正在安全準備文件與圖片內容…', { phase: 'media_preflight' });
        preparedMedia = await prepareMediaHandles(request.messages, config.limits, { signal: abortController.signal });
        request.messages = preparedMedia.messages;
      }
      rawBody = null;
      original = null;
      releaseIngress(); releaseIngress = null;

      const beforeAcquire = admission.health().managed;
      const queuedAt = Date.now();
      releaseManaged = await admission.acquireManaged({
        requestId,
        signal: abortController.signal,
        onPosition: (position) => {
          log(config, 'info', 'managed_job_enqueued', { requestId, position, queued: admission.health().managed.queued });
          progress?.update(`任務正在排隊，目前前方有 ${position} 個任務…`, { force: true }).catch(() => {});
        },
      });
      if (beforeAcquire.active >= beforeAcquire.limit) {
        await progress?.update('任務已開始處理…', { force: true });
      }
      log(config, 'info', 'managed_job_admitted', { requestId, queue_wait_ms: Date.now() - queuedAt });

      if (hasMedia) {
        const adapters = createMediaAdapters(config, abortController.signal, onProgress, {
          allowedMediaPaths: preparedMedia.allowedPaths,
          acquireVision: (options) => admission.acquireVision(options),
        });
        request.messages = await adaptMessages(request.messages, adapters);
        await preparedMedia.cleanup(); preparedMedia = null;
        await onProgress('文件與圖片內容已就緒；正在交給模型分析…', { phase: 'media_ready' });
      }

      if (messagesPath === '/v1/messages/count_tokens') {
        releaseManaged(); releaseManaged = null;
        const payload = await callUpstreamJson(request, config, req.headers, abortController.signal, messagesPath);
        completed = true;
        return sendJson(res, 200, payload);
      }

      const upstream = (body, signal) => callUpstreamJson(body, config, req.headers, signal);
      if (hasManagedTools) {
        const result = await runManagedLoop(request, {
          upstream,
          executeTool: (toolUse, signal) => executeManagedTool(toolUse, config, signal),
          maxRounds: config.maxToolRounds,
          onProgress,
          signal: abortController.signal,
        });
        releaseManaged(); releaseManaged = null;
        if (request.stream === true) await emitFinalAnthropicResponse(progress, result);
        else sendJson(res, 200, result);
      } else {
        releaseManaged(); releaseManaged = null;
        if (request.stream === true) await streamManagedBase(progress, request, config, req.headers, abortController.signal);
        else sendJson(res, 200, await callUpstreamJson(request, config, req.headers, abortController.signal));
      }

      completed = true;
      log(config, 'info', 'request_completed', { requestId, hasMedia, managed: hasManagedTools });
    } catch (error) {
      if (abortController.signal.aborted && res.destroyed) return;
      const failureLevel = ['proxy_queue_full', 'proxy_queue_timeout'].includes(error.code) ? 'warn' : 'error';
      log(config, failureLevel, 'request_failed', { requestId, method: req.method, path: url.pathname, code: error.code || 'internal_error', message: error.message });
      if (['proxy_queue_full', 'proxy_queue_timeout'].includes(error.code) && !res.headersSent) res.setHeader('retry-after', '10');
      if (progress) await emitSseError(progress, error);
      else if (!res.headersSent) sendError(res, error);
      else res.destroy(error);
      completed = true;
    } finally {
      releaseIngress?.();
      releaseManaged?.();
      await preparedMedia?.cleanup();
    }
  });
}
