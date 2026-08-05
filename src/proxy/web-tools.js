import { HttpError } from '../lib/http.js';
import { boundedText, fetchJson, serviceEndpoint } from '../lib/media.js';

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

async function webSearch(input, config, signal) {
  if (!config.searxngUrl) throw new HttpError(422, 'SEARXNG_URL is not configured.', { code: 'web_search_unavailable' });
  const query = searchQuery(input);
  const endpoint = new URL(serviceEndpoint(config.searxngUrl, '/search'));
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  const payload = await fetchJson(endpoint, { method: 'GET', signal }, { errorCode: 'web_search_error' });
  const results = Array.isArray(payload.results) ? payload.results.slice(0, 10).map((item) => ({
    title: String(item.title || '').slice(0, 500),
    url: String(item.url || ''),
    snippet: String(item.content || item.snippet || '').slice(0, 2000),
    published_date: item.publishedDate || item.published_date || null,
    engine: item.engine || null,
  })) : [];
  return { query, result_count: results.length, results };
}

async function webFetch(input, config, signal) {
  if (!config.webFetchUrl) throw new HttpError(422, 'WEB_FETCH_URL is not configured.', { code: 'web_fetch_unavailable' });
  const targetUrl = validateFetchTarget(input?.url);
  const payload = await fetchJson(serviceEndpoint(config.webFetchUrl, '/v1/fetch'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      output: input?.output || 'markdown',
      timeout_ms: input?.timeout_ms,
    }),
    signal,
  }, { errorCode: 'web_fetch_error' });
  const content = boundedText(payload.markdown || payload.content || payload.text || '', config.limits.maxOutputChars);
  return {
    requested_url: targetUrl,
    final_url: payload.final_url || targetUrl,
    status: payload.status || 200,
    title: payload.title || '',
    content_type: payload.content_type || '',
    markdown: content.text,
    truncated: Boolean(payload.truncated || content.truncated),
    warnings: payload.warnings || [],
    fetch_backend: payload.fetch_backend || 'awesome-web-fetch',
  };
}

export async function executeManagedTool(block, config, signal) {
  const name = normalizeManagedToolName(block?.name);
  if (!name) throw new HttpError(422, `Unsupported managed tool: ${block?.name || 'unknown'}`, { code: 'unsupported_managed_tool' });
  if (name === 'WebSearch') return webSearch(block.input || {}, config, signal);
  return webFetch(block.input || {}, config, signal);
}
