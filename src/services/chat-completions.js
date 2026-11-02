import { HttpError, sendJson, writeChunk } from '../lib/http.js';
import { resolveModelRoute } from '../proxy/model-router.js';
import { buildUpstreamUrl } from '../proxy/bypass.js';
import { requestBaseUpstream } from './base-upstream.js';
import { isObject, invalidUpstream, readUpstreamJson, relayOpenAIStream, sseData } from './chat-stream.js';
import { toAnthropicRequest, fromAnthropicResponse, fromAnthropicStream } from './openai-client-adapter.js';

export function isOpenAIClientPath(value) {
  try { return ['/v1/models', '/v1/chat/completions'].includes(new URL(value, 'http://proxy.local').pathname.replace(/\/+$/, '')); }
  catch { return false; }
}
export function openAIErrorBody(error) {
  const status = error instanceof HttpError ? error.status : 500;
  return { error: { message: error instanceof HttpError ? error.message : 'Internal proxy error.',
    type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error',
    param: error?.details?.param || null, code: error instanceof HttpError ? error.code : 'internal_error' } };
}
export async function sendOpenAIError(res, error, config) {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) return sendJson(res, error instanceof HttpError ? error.status : 500, openAIErrorBody(error));
  // A stream error has no finish_reason and no [DONE]. Never fake success.
  try { await writeChunk(res, sseData(openAIErrorBody(error)), { drainTimeoutMs: config.sseDrainTimeoutMs }); res.end(); }
  catch { res.destroy(); }
}
export function routedModelList(config) {
  return { object: 'list', data: Object.keys(config.modelRouting.routes).map(id => ({ id, object: 'model', created: 0, owned_by: 'cc-tool-proxy' })) };
}
function parseRequest(rawBody) {
  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Request body is not valid JSON.', { code: 'invalid_json' }); }
  if (!isObject(body) || typeof body.model !== 'string' || !body.model || !Array.isArray(body.messages) || !body.messages.length || !body.messages.every(isObject)) {
    throw new HttpError(400, 'Chat Completions requires a model and a non-empty messages array.', { code: 'invalid_request' });
  }
  if (body.stream != null && typeof body.stream !== 'boolean') throw new HttpError(400, 'stream must be a boolean.', { code: 'invalid_request', details: { param: 'stream' } });
  if (body.n != null && (!Number.isSafeInteger(body.n) || body.n < 1)) throw new HttpError(400, 'n must be a positive integer.', { code: 'invalid_request', details: { param: 'n' } });
  return body;
}
function responseHeaders(response) {
  const headers = {};
  for (const name of ['x-request-id', 'request-id', 'retry-after', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens']) {
    const value = response.headers.get(name); if (value != null) headers[name] = value;
  }
  return headers;
}
function backendHeaders(route, incoming) {
  // Only configured credentials belong on this hop, even when ingress auth is off.
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'accept-encoding': 'identity' };
  if (route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
  if (route.protocol === 'anthropic') {
    headers['anthropic-version'] = typeof incoming['anthropic-version'] === 'string' ? incoming['anthropic-version'] : '2023-06-01';
    if (typeof incoming['anthropic-beta'] === 'string') headers['anthropic-beta'] = incoming['anthropic-beta'];
    if (route.apiKey) headers['x-api-key'] = route.apiKey;
  }
  return headers;
}

export async function forwardChatCompletions(req, res, config, { rawBody, signal, onEvent = () => {} } = {}) {
  const original = parseRequest(rawBody);
  // Immutable local selection survives async streaming and concurrent requests.
  const route = resolveModelRoute(original.model, config), native = route.protocol === 'openai';
  const model = route.model || original.model;
  const request = native ? { ...original, model } : toAnthropicRequest(original, model);
  const incoming = new URL(req.url, 'http://proxy.local');
  const path = native ? '/v1/chat/completions' : '/v1/messages';
  const url = buildUpstreamUrl(route.url, path + incoming.search);
  onEvent('chat_route_selected', { client_model: original.model, upstream_model: model, protocol: route.protocol, route_alias: route.alias, path, stream: original.stream === true });
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const limitBytes = config.limits.maxRequestBytes;
  try {
    const response = await requestBaseUpstream(url, { method: 'POST', headers: backendHeaders(route, req.headers), body: JSON.stringify(request), signal: controller.signal }, config.vllmBaseTimeouts);
    const headers = responseHeaders(response);
    if (!response.ok) {
      let payload;
      try { payload = await readUpstreamJson(response.body, Math.min(limitBytes, 1024 * 1024)); } catch { /* Never expose an upstream HTML error page. */ }
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      const err = new HttpError(status, typeof payload?.error?.message === 'string' ? payload.error.message : 'Upstream rejected the Chat Completions request.', { code: 'upstream_error' });
      const body = openAIErrorBody(err);
      if (typeof payload?.error?.code === 'string') body.error.code = payload.error.code;
      if (typeof payload?.error?.type === 'string') body.error.type = payload.error.type;
      if (typeof payload?.error?.param === 'string') body.error.param = payload.error.param;
      return sendJson(res, status, body, headers);
    }
    const stream = original.stream === true;
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (stream) {
      if (!contentType.includes('text/event-stream')) throw invalidUpstream('Upstream did not return an SSE stream.');
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', ...headers });
      res.flushHeaders();
      const output = native
        ? relayOpenAIStream(response.body, original.model, { limitBytes, n: original.n ?? 1 })
        : fromAnthropicStream(response.body, original.model, { limitBytes, includeUsage: original.stream_options?.include_usage === true });
      for await (const part of output) await writeChunk(res, part, { drainTimeoutMs: config.sseDrainTimeoutMs });
      res.end();
    } else {
      const payload = await readUpstreamJson(response.body, limitBytes);
      if (payload.error) return sendJson(res, 502, { error: payload.error }, headers);
      if (native && !Array.isArray(payload.choices)) throw invalidUpstream('OpenAI response has no choices array.');
      const result = native ? { ...payload, model: original.model } : fromAnthropicResponse(payload, original.model);
      sendJson(res, response.status, result, headers);
    }
    onEvent('chat_request_completed', { client_model: original.model, protocol: route.protocol, route_alias: route.alias, stream });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Also cancel a partially consumed/error response to release the backend lane.
    if (!controller.signal.aborted) controller.abort();
  }
}
