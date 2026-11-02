// Token counting is a backend operation: never infer a count from characters,
// ask a generation endpoint, or move to a different route after an error.
import { HttpError } from '../lib/http.js';
import { requestBaseUpstream } from './base-upstream.js';
import { toOpenAIRequest } from './openai-upstream-adapter.js';
import { isObject, readUpstreamJson } from './chat-stream.js';

const TOKENIZER_PATHS = ['/tokenize', '/v1/tokenize'];
const UNSUPPORTED = new Set([404, 405, 501]);

export function tokenEndpoint(baseUrl, endpoint) {
  const url = new URL(baseUrl);
  let prefix = url.pathname.replace(/\/+$/, '');
  prefix = prefix.replace(/\/v1\/(?:chat\/completions|messages(?:\/count_tokens)?|models|tokenize)$/, '');
  prefix = prefix.replace(/\/v1$/, '');
  url.pathname = `${prefix}${endpoint}`.replace(/\/{2,}/g, '/');
  url.hash = '';
  return url.toString();
}

export function toTokenizeRequest(request, options = {}) {
  // Use the inference adapter so system text, tool schemas, images and tool
  // history have exactly the same representation as the OpenAI inference hop.
  const converted = toOpenAIRequest(request, options);
  const { stream, max_tokens, temperature, top_p, stop, ...prompt } = converted;
  return { ...prompt, add_generation_prompt: true };
}

function invalidCount() {
  return new HttpError(502, 'Backend returned an invalid token count.', { code: 'vllm_invalid_token_count' });
}
function requireCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidCount();
  return value;
}

async function requestCount(route, endpoint, body, config, { signal, incomingHeaders = {}, onEvent = () => {} } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity' };
  // Client authentication never belongs on the backend hop, even with auth off.
  if (route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;
  if (endpoint.endsWith('/count_tokens') || route.protocol === 'anthropic') {
    headers['anthropic-version'] = incomingHeaders['anthropic-version'] || '2023-06-01';
    if (typeof incomingHeaders['anthropic-beta'] === 'string') headers['anthropic-beta'] = incomingHeaders['anthropic-beta'];
    if (route.apiKey) headers['x-api-key'] = route.apiKey;
  }
  onEvent('token_count_upstream_request', { route_alias: route.alias, upstream_model: body.model, protocol: route.protocol, endpoint_path: endpoint });
  try {
    const response = await requestBaseUpstream(tokenEndpoint(route.url, endpoint), {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    }, config.vllmBaseTimeouts);
    let payload;
    try { payload = await readUpstreamJson(response.body, response.ok ? (config.limits?.maxRequestBytes ?? 16 * 1024 * 1024) : 65536); }
    catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw error;
      // Transport failures must not masquerade as an unsupported endpoint.
      if (error?.code !== 'invalid_upstream_response') throw error;
      if (response.ok) throw invalidCount();
    }
    const modelError = /model.*(?:not_found|not_exist|invalid)|invalid_model|unknown_model/i.test(String(payload?.error?.code || payload?.error?.type || ''));
    if (UNSUPPORTED.has(response.status) && !modelError) {
      onEvent('token_count_endpoint_unsupported', { route_alias: route.alias, endpoint_path: endpoint, http_status: response.status });
      return null;
    }
    if (!response.ok || payload?.error) {
      // Do not echo backend bodies: some backends include prompts or secrets.
      throw new HttpError(response.status >= 400 && response.status <= 599 ? response.status : 502,
        'Selected backend rejected the token-count request.', { code: 'token_count_upstream_error', retryable: response.status === 429 || response.status >= 500,
          details: { endpoint_path: endpoint, upstream_status: response.status } });
    }
    return payload;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Also release an incompletely consumed body on size/parser errors.
    if (!controller.signal.aborted) controller.abort();
  }
}

function unsupported() {
  return new HttpError(501, 'Selected backend does not expose a supported token-count endpoint.', { code: 'token_count_unsupported' });
}

// Native tokenizer utility. Keep vendor flags and token IDs; only rewrite model.
export async function tokenizeOnRoute(request, route, config, options = {}) {
  if (!isObject(request)) throw new HttpError(400, 'Tokenizer request must be a JSON object.', { code: 'invalid_request' });
  const body = { ...request, model: route.model || request.model };
  for (const endpoint of TOKENIZER_PATHS) {
    const payload = await requestCount(route, endpoint, body, config, options);
    if (payload === null) continue;
    requireCount(payload.count);
    options.onEvent?.('token_count_succeeded', { route_alias: route.alias, upstream_model: body.model, endpoint_path: endpoint, input_tokens: payload.count });
    return payload;
  }
  throw unsupported();
}

export async function countOpenAIInputTokens(request, route, config, options = {}) {
  // route is the immutable request-scoped selection; never re-resolve its real
  // model name as a public alias and never fall back to the global Base server.
  const body = toTokenizeRequest({ ...request, model: route.model || request.model }, {
    mapThinkingBudget: route.thinkingBudgetEnabled ?? config.vllmOpenaiThinkingBudgetEnabled ?? false,
    thinkingBudgetFormat: route.thinkingBudgetFormat,
  });
  for (const endpoint of TOKENIZER_PATHS) {
    const payload = await requestCount(route, endpoint, body, config, options);
    if (payload === null) continue;
    const count = requireCount(payload.count);
    options.onEvent?.('token_count_succeeded', { route_alias: route.alias, upstream_model: body.model, endpoint_path: endpoint, input_tokens: count });
    return { input_tokens: count };
  }
  // Some OpenAI-compatible deployments expose only the Messages counter.
  // This is capability fallback on the SAME backend, not model fallback.
  const countBody = { model: body.model };
  for (const field of ['messages', 'system', 'tools', 'tool_choice', 'thinking', 'output_config']) {
    if (request[field] !== undefined) countBody[field] = request[field];
  }
  const endpoint = '/v1/messages/count_tokens';
  const payload = await requestCount(route, endpoint, countBody, config, options);
  if (payload === null) throw unsupported();
  const count = requireCount(payload.input_tokens);
  options.onEvent?.('token_count_succeeded', { route_alias: route.alias, upstream_model: body.model, endpoint_path: endpoint, input_tokens: count });
  return { input_tokens: count };
}
