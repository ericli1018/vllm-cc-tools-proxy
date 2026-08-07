import { HttpError } from '../lib/http.js';
import { processWebFetchContent } from '../services/web-fetch-processor.js';
import { boundedText, fetchJson, serviceEndpoint } from '../lib/media.js';
import { isUrlAllowedByWebPolicy } from './native-web-tools.js';

const MANAGED = new Map([
  ['WebSearch', 'WebSearch'],
  ['web_search', 'WebSearch'],
  ['WebFetch', 'WebFetch'],
  ['web_fetch', 'WebFetch'],
]);

export function normalizeManagedToolName(name) {
  return MANAGED.get(name) || '';
}

export function isManagedToolName(name) {
  return MANAGED.has(name);
}

function normalizeDomainArgument(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

export function normalizeManagedToolUseBlock(block) {
  if (!block || block.type !== 'tool_use' || !isManagedToolName(block.name) || !block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
    return block;
  }
  let changed = false;
  const input = { ...block.input };
  for (const field of ['allowed_domains', 'blocked_domains']) {
    const normalized = normalizeDomainArgument(input[field]);
    if (normalized !== input[field]) {
      input[field] = normalized;
      changed = true;
    }
  }
  return changed ? { ...block, input } : block;
}

function searchQuery(input) {
  const query = input?.query ?? input?.q;
  if (typeof query !== 'string' || !query.trim()) {
    throw new HttpError(422, 'WebSearch requires a non-empty query.', { code: 'invalid_tool_input' });
  }
  return query.trim().slice(0, 1000);
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

export function validateFetchTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(422, 'WebFetch URL is invalid.', { code: 'invalid_tool_input' }); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(422, 'WebFetch only supports HTTP and HTTPS URLs.', { code: 'invalid_tool_input' });
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.localhost') || isPrivateIpv4(hostname)) {
    throw new HttpError(422, 'WebFetch target is not allowed by the SSRF policy.', { code: 'blocked_fetch_target' });
  }
  url.username = '';
  url.password = '';
  return url.toString();
}

async function webSearch(input, config, signal, policy = {}) {
  if (!config.searxngUrl) throw new HttpError(422, 'SEARXNG_URL is not configured.', { code: 'web_search_unavailable' });
  const query = searchQuery(input);
  const endpoint = new URL(serviceEndpoint(config.searxngUrl, '/search'));
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  const payload = await fetchJson(endpoint, { method: 'GET', signal }, { errorCode: 'web_search_error' });
  const candidates = Array.isArray(payload.results) ? payload.results.map((item) => ({
    title: String(item.title || '').slice(0, 500),
    url: String(item.url || ''),
    snippet: String(item.content || item.snippet || '').slice(0, 2000),
    published_date: item.publishedDate || item.published_date || null,
    engine: item.engine || null,
  })) : [];
  const permitted = candidates.filter((item) => isUrlAllowedByWebPolicy(item.url, policy));
  const results = permitted.slice(0, 10);
  return {
    query,
    result_count: results.length,
    ...(permitted.length === candidates.length ? {} : { filtered_result_count: candidates.length - permitted.length }),
    results,
  };
}

function webFetchErrorMessage(payload) {
  if (typeof payload?.detail === 'string' && payload.detail) return payload.detail;
  if (typeof payload?.error === 'string' && payload.error) return payload.error;
  if (typeof payload?.error?.message === 'string' && payload.error.message) return payload.error.message;
  if (typeof payload?.message === 'string' && payload.message) return payload.message;
  return 'Service rejected the request.';
}

function normalizeWebFetchPayload(payload, targetUrl, maxChars) {
  const item = Array.isArray(payload) ? payload[0] || {} : payload || {};
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const rawContent = item.page_content ?? item.markdown ?? item.content ?? item.text ?? '';
  const content = boundedText(rawContent, maxChars);
  return {
    requested_url: targetUrl,
    final_url: metadata.final_url || metadata.source || item.final_url || targetUrl,
    status: metadata.status_code || item.status || 200,
    title: metadata.title || item.title || '',
    content_type: metadata.content_type || item.content_type || '',
    markdown: content.text,
    truncated: Boolean(item.truncated || content.truncated),
    warnings: Array.isArray(item.warnings) ? item.warnings : [],
    browser_rendered: Boolean(metadata.browser_rendered || item.browser_rendered),
    fetch_backend: item.fetch_backend || 'awesome-web-fetch',
    retrieved_at: new Date().toISOString(),
  };
}

async function webFetch(input, config, signal, onEvent = () => {}, { model = '', policy = {}, acquireProcessor } = {}) {
  if (!config.webFetchUrl) throw new HttpError(422, 'WEB_FETCH_URL is not configured.', { code: 'web_fetch_unavailable' });
  const targetUrl = validateFetchTarget(input?.url);
  if (!isUrlAllowedByWebPolicy(targetUrl, policy)) {
    throw new HttpError(422, 'WebFetch target is blocked by the native web tool domain policy.', {
      code: 'blocked_web_domain', retryable: false,
    });
  }
  const target = new URL(targetUrl);
  const backend = new URL(config.webFetchUrl);
  const headers = { 'content-type': 'application/json' };
  if (config.webFetchApiKey) headers.authorization = `Bearer ${config.webFetchApiKey}`;
  const startedAt = Date.now();
  await onEvent('web_fetch_upstream_request', {
    target_host: target.host,
    backend_host: backend.host,
    endpoint_path: backend.pathname || '/',
    authenticated: Boolean(config.webFetchApiKey),
  });

  let response;
  try {
    response = await fetch(config.webFetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ urls: [targetUrl] }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    await onEvent('web_fetch_upstream_rejected', {
      target_host: target.host,
      backend_host: backend.host,
      endpoint_path: backend.pathname || '/',
      http_status: 0,
      elapsed_ms: Date.now() - startedAt,
      response_content_type: '',
      response_keys: [],
      cause_code: String(error?.cause?.code || error?.code || 'unknown').slice(0, 120),
    });
    throw new HttpError(502, `Unable to reach service: ${backend.host}`, {
      code: 'web_fetch_error', retryable: true,
    });
  }

  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch {
    await onEvent('web_fetch_upstream_rejected', {
      target_host: target.host,
      backend_host: backend.host,
      endpoint_path: backend.pathname || '/',
      http_status: response.status,
      elapsed_ms: Date.now() - startedAt,
      response_content_type: response.headers.get('content-type') || '',
      response_keys: [],
      cause_code: 'invalid_json',
    });
    throw new HttpError(502, 'Service returned invalid JSON.', {
      code: 'web_fetch_error', retryable: true,
      details: { upstream_status: response.status, upstream_code: '' },
    });
  }
  if (!response.ok) {
    const upstreamCode = typeof payload?.error?.type === 'string'
      ? payload.error.type
      : typeof payload?.code === 'string' ? payload.code : '';
    await onEvent('web_fetch_upstream_rejected', {
      target_host: target.host,
      backend_host: backend.host,
      endpoint_path: backend.pathname || '/',
      http_status: response.status,
      elapsed_ms: Date.now() - startedAt,
      response_content_type: response.headers.get('content-type') || '',
      response_keys: payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Object.keys(payload).sort()
        : [],
      cause_code: upstreamCode,
    });
    throw new HttpError(response.status >= 500 ? 502 : response.status, webFetchErrorMessage(payload), {
      code: 'web_fetch_error',
      retryable: response.status >= 500,
      details: { upstream_status: response.status, upstream_code: upstreamCode },
    });
  }
  const policyChars = Number.isInteger(policy.maxContentTokens)
    ? policy.maxContentTokens * 4
    : config.limits.maxOutputChars;
  const maxChars = Math.min(config.limits.maxOutputChars, policyChars);
  const normalized = normalizeWebFetchPayload(payload, targetUrl, maxChars);
  await onEvent('web_fetch_upstream_response', {
    target_host: target.host,
    backend_host: backend.host,
    endpoint_path: backend.pathname || '/',
    http_status: response.status,
    elapsed_ms: Date.now() - startedAt,
    response_content_type: response.headers.get('content-type') || '',
    result_count: Array.isArray(payload) ? payload.length : 1,
    content_chars: normalized.markdown.length,
    truncated: normalized.truncated,
  });
  if (!config.webFetchProcessor) return normalized;
  return processWebFetchContent(normalized, {
    prompt: String(input?.prompt || ''),
    model,
    processor: config.webFetchProcessor,
    signal,
    onEvent,
    acquireProcessor,
  });
}

export async function executeManagedTool(block, config, signal, { onEvent = () => {}, model = '', policy = {}, acquireProcessor } = {}) {
  const name = normalizeManagedToolName(block?.name);
  if (!name) throw new HttpError(422, `Unsupported managed tool: ${block?.name || 'unknown'}`, { code: 'unsupported_managed_tool' });
  if (name === 'WebSearch') return webSearch(block.input || {}, config, signal, policy);
  return webFetch(block.input || {}, config, signal, onEvent, { model, policy, acquireProcessor });
}
