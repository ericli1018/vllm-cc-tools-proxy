import crypto from 'node:crypto';
import { HttpError } from '../lib/http.js';

const NATIVE_SEARCH_TYPE = /^web_search_[0-9]{8}$/;
const NATIVE_FETCH_TYPE = /^web_fetch_[0-9]{8}$/;
const KNOWN_NATIVE_FIELDS = new Set([
  'type', 'name', 'max_uses', 'allowed_domains', 'blocked_domains',
  'user_location', 'max_content_tokens', 'citations',
]);

const SEARCH_SCHEMA = Object.freeze({
  name: 'web_search',
  description: 'Search the web for current and relevant information. Provide one concise search query.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
});

const FETCH_SCHEMA = Object.freeze({
  name: 'web_fetch',
  description: 'Fetch and process content from a specific HTTP or HTTPS URL. Optionally state what information to extract.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
      prompt: { type: 'string', description: 'Optional extraction or analysis instruction.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
});

export function canonicalWebToolName(value) {
  if (value === 'WebSearch' || value === 'web_search') return 'WebSearch';
  if (value === 'WebFetch' || value === 'web_fetch') return 'WebFetch';
  if (typeof value === 'string' && NATIVE_SEARCH_TYPE.test(value)) return 'WebSearch';
  if (typeof value === 'string' && NATIVE_FETCH_TYPE.test(value)) return 'WebFetch';
  return '';
}

function canonicalName(value) {
  return canonicalWebToolName(value);
}

function nativeCanonical(tool) {
  const type = typeof tool?.type === 'string' ? tool.type : '';
  if (NATIVE_SEARCH_TYPE.test(type)) return 'WebSearch';
  if (NATIVE_FETCH_TYPE.test(type)) return 'WebFetch';
  return '';
}

export function isNativeWebToolDefinition(tool) {
  return Boolean(nativeCanonical(tool));
}

export function detectServerWebUiDeclaration(request) {
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  let search = false;
  let fetch = false;
  let nativeCount = 0;
  let aliasCount = 0;
  for (const tool of tools) {
    const native = nativeCanonical(tool);
    if (native) {
      nativeCount += 1;
      if (native === 'WebSearch') search = true;
      if (native === 'WebFetch') fetch = true;
      continue;
    }
    const alias = canonicalWebToolName(tool?.name);
    if (!alias) continue;
    aliasCount += 1;
    if (alias === 'WebSearch') search = true;
    if (alias === 'WebFetch') fetch = true;
  }
  return {
    eligible: search || fetch,
    search,
    fetch,
    native_count: nativeCount,
    alias_count: aliasCount,
  };
}

function positiveInteger(value, field, { nullable = true } = {}) {
  if (value === undefined || value === null) return nullable ? null : undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer.`, {
      code: 'invalid_native_web_tool_policy', retryable: false,
      details: { field },
    });
  }
  return value;
}

function normalizeDomainRule(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${field} entries must be non-empty domain strings.`, {
      code: 'invalid_native_web_tool_policy', retryable: false,
      details: { field },
    });
  }
  const rule = value.trim().toLowerCase().replace(/\/$/, '');
  if (rule.includes('://') || rule.includes('?') || rule.includes('#') || rule.includes('@')) {
    throw new HttpError(400, `${field} entries must be bare domains with an optional path.`, {
      code: 'invalid_native_web_tool_policy', retryable: false,
      details: { field },
    });
  }
  const [host] = rule.split('/');
  if (!host || host === 'localhost' || !/^[a-z0-9.-]+$/.test(host)) {
    throw new HttpError(400, `${field} contains an invalid domain.`, {
      code: 'invalid_native_web_tool_policy', retryable: false,
      details: { field },
    });
  }
  return rule;
}

function domainList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array.`, {
      code: 'invalid_native_web_tool_policy', retryable: false,
      details: { field },
    });
  }
  return [...new Set(value.map((entry) => normalizeDomainRule(entry, field)))];
}

function policyFromTool(tool, canonical) {
  const allowedDomains = domainList(tool.allowed_domains, 'allowed_domains');
  const blockedDomains = domainList(tool.blocked_domains, 'blocked_domains');
  if (allowedDomains.length && blockedDomains.length) {
    throw new HttpError(400, 'allowed_domains and blocked_domains cannot be used together.', {
      code: 'invalid_native_web_tool_policy', retryable: false,
      details: { tool: canonical },
    });
  }
  const expectedName = canonical === 'WebSearch' ? 'web_search' : 'web_fetch';
  if (typeof tool.name === 'string' && tool.name !== expectedName) {
    throw new HttpError(400, `Native ${expectedName} type must use name=${expectedName}.`, {
      code: 'invalid_native_web_tool_definition', retryable: false,
      details: { type: tool.type, name: tool.name },
    });
  }
  const unsupportedFields = Object.keys(tool)
    .filter((key) => !KNOWN_NATIVE_FIELDS.has(key))
    .sort();
  return {
    nativeType: tool.type,
    maxUses: positiveInteger(tool.max_uses, 'max_uses'),
    allowedDomains,
    blockedDomains,
    userLocation: canonical === 'WebSearch' && tool.user_location && typeof tool.user_location === 'object'
      ? structuredClone(tool.user_location)
      : null,
    maxContentTokens: canonical === 'WebFetch'
      ? positiveInteger(tool.max_content_tokens, 'max_content_tokens')
      : null,
    citationsEnabled: canonical === 'WebFetch' && tool.citations?.enabled === true,
    unsupportedFields,
  };
}

function customDefinition(canonical) {
  return structuredClone(canonical === 'WebSearch' ? SEARCH_SCHEMA : FETCH_SCHEMA);
}

export function normalizeNativeWebToolsRequest(request) {
  if (!request || !Array.isArray(request.tools) || !request.tools.some(isNativeWebToolDefinition)) {
    return { request, changed: false, nativeToolCount: 0, policies: {} };
  }

  const customCanonicalNames = new Set(
    request.tools
      .filter((tool) => !isNativeWebToolDefinition(tool))
      .map((tool) => canonicalName(tool?.name))
      .filter(Boolean),
  );
  const emittedNative = new Set();
  const policies = {};
  const tools = [];
  let nativeToolCount = 0;

  for (const tool of request.tools) {
    const canonical = nativeCanonical(tool);
    if (!canonical) {
      tools.push(tool);
      continue;
    }
    nativeToolCount += 1;
    if (!policies[canonical]) policies[canonical] = policyFromTool(tool, canonical);
    if (customCanonicalNames.has(canonical) || emittedNative.has(canonical)) continue;
    tools.push(customDefinition(canonical));
    emittedNative.add(canonical);
  }

  return {
    request: { ...request, tools },
    changed: true,
    nativeToolCount,
    policies,
  };
}

const RESPONSE_SIDE_NATIVE_WEB_TOOL_USES = new WeakSet();

const NATIVE_WEB_RESULT_TYPES = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
]);

function responseServerToolCanonical(block) {
  if (block?.type !== 'server_tool_use') return '';
  return canonicalName(block?.name);
}

export function isResponseSideNativeWebToolUse(block) {
  return Boolean(block && typeof block === 'object' && RESPONSE_SIDE_NATIVE_WEB_TOOL_USES.has(block));
}

export function containsNativeWebResponseBlocks(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  return content.some((block) => Boolean(responseServerToolCanonical(block))
    || NATIVE_WEB_RESULT_TYPES.has(block?.type));
}

export function normalizeNativeWebToolResponse(response) {
  if (!response || !Array.isArray(response.content) || !containsNativeWebResponseBlocks(response)) {
    return {
      response,
      changed: false,
      serverToolUseCount: 0,
      strippedResultCount: 0,
    };
  }

  const content = [];
  let serverToolUseCount = 0;
  let strippedResultCount = 0;
  for (const block of response.content) {
    const canonical = responseServerToolCanonical(block);
    if (canonical) {
      serverToolUseCount += 1;
      const normalizedBlock = {
        type: 'tool_use',
        id: block.id,
        name: canonical === 'WebSearch' ? 'web_search' : 'web_fetch',
        input: block.input && typeof block.input === 'object' ? structuredClone(block.input) : {},
      };
      RESPONSE_SIDE_NATIVE_WEB_TOOL_USES.add(normalizedBlock);
      content.push(normalizedBlock);
      continue;
    }
    if (NATIVE_WEB_RESULT_TYPES.has(block?.type)) {
      strippedResultCount += 1;
      continue;
    }
    content.push(block);
  }

  return {
    response: {
      ...response,
      content,
      ...(serverToolUseCount > 0 ? { stop_reason: 'tool_use' } : {}),
    },
    changed: true,
    serverToolUseCount,
    strippedResultCount,
  };
}

export function containNativeWebResponseForClient(response) {
  if (!response || !Array.isArray(response.content)) return response;
  const content = response.content.filter((block) => !responseServerToolCanonical(block)
    && !NATIVE_WEB_RESULT_TYPES.has(block?.type));
  return content.length === response.content.length ? response : { ...response, content };
}

export function createManagedWebPolicyEnforcer(policies = {}) {
  const uses = new Map();
  return {
    consume(name) {
      const canonical = canonicalName(name);
      const policy = canonical && policies[canonical] ? policies[canonical] : {};
      const attemptedUse = (uses.get(canonical) || 0) + 1;
      uses.set(canonical, attemptedUse);
      if (Number.isInteger(policy.maxUses) && attemptedUse > policy.maxUses) {
        throw new HttpError(422, `${canonical} exceeded max_uses=${policy.maxUses}.`, {
          code: 'max_uses_exceeded', retryable: false,
          details: { tool: canonical, max_uses: policy.maxUses, attempted_use: attemptedUse },
        });
      }
      return policy;
    },
    snapshot() {
      return Object.fromEntries(uses);
    },
  };
}


function serverWebName(canonical) {
  return canonical === 'WebSearch' ? 'web_search' : canonical === 'WebFetch' ? 'web_fetch' : '';
}

export function createServerWebToolUse(toolUse) {
  const canonical = canonicalWebToolName(toolUse?.name);
  if (!canonical) return null;
  const id = `srvtoolu_${crypto.randomUUID().replaceAll('-', '')}`;
  return {
    id,
    canonical,
    originalId: typeof toolUse?.id === 'string' ? toolUse.id : '',
    block: {
      type: 'server_tool_use',
      id,
      name: serverWebName(canonical),
      input: toolUse?.input && typeof toolUse.input === 'object' && !Array.isArray(toolUse.input)
        ? structuredClone(toolUse.input)
        : {},
    },
  };
}

function localOpaqueSearchContent(item) {
  const identity = JSON.stringify([
    String(item?.title || ''),
    String(item?.url || ''),
    String(item?.published_date || item?.page_age || ''),
  ]);
  return `vcc_local_${crypto.createHash('sha256').update(identity).digest('base64url')}`;
}

function mapSearchErrorCode(code) {
  if (['max_uses_exceeded', 'invalid_tool_input', 'query_too_long', 'request_too_large', 'too_many_requests'].includes(code)) return code;
  return 'unavailable';
}

function mapFetchErrorCode(code) {
  if (code === 'max_uses_exceeded') return code;
  if (code === 'invalid_tool_input') return code;
  if (['blocked_fetch_target', 'blocked_web_domain'].includes(code)) return 'url_not_allowed';
  if (code === 'web_fetch_error') return 'url_not_accessible';
  if (code === 'too_many_requests') return 'too_many_requests';
  return 'unavailable';
}

export function createServerWebToolResult(canonicalInput, toolUseId, output, error = null) {
  const canonical = canonicalWebToolName(canonicalInput) || canonicalInput;
  if (canonical === 'WebSearch') {
    if (error) {
      return {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        content: { type: 'web_search_tool_result_error', error_code: mapSearchErrorCode(String(error?.code || '')) },
      };
    }
    const results = Array.isArray(output?.results) ? output.results : [];
    return {
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      content: results.map((item) => ({
        type: 'web_search_result',
        title: String(item?.title || '').slice(0, 500),
        url: String(item?.url || ''),
        encrypted_content: localOpaqueSearchContent(item),
        page_age: item?.published_date || item?.page_age
          ? String(item.published_date || item.page_age).slice(0, 120)
          : null,
      })),
    };
  }
  if (canonical === 'WebFetch') {
    if (error) {
      return {
        type: 'web_fetch_tool_result',
        tool_use_id: toolUseId,
        content: { type: 'web_fetch_tool_result_error', error_code: mapFetchErrorCode(String(error?.code || '')) },
      };
    }
    const url = String(output?.final_url || output?.requested_url || '');
    const data = String(output?.result ?? output?.markdown ?? '');
    let fallbackTitle = 'Fetched document';
    try { fallbackTitle = new URL(url).hostname || fallbackTitle; } catch {}
    const title = String(output?.title || fallbackTitle).slice(0, 500);
    const retrievedAt = output?.retrieved_at ? String(output.retrieved_at) : new Date().toISOString();
    return {
      type: 'web_fetch_tool_result',
      tool_use_id: toolUseId,
      content: {
        type: 'web_fetch_result',
        url,
        content: {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data },
          title,
        },
        retrieved_at: retrievedAt,
      },
    };
  }
  return null;
}


function renderCompletedServerWebEvidence(block, maxChars) {
  if (block?.type === 'web_search_tool_result') {
    if (!Array.isArray(block.content)) {
      const code = String(block?.content?.error_code || 'unavailable');
      return `[VCC_SERVER_WEB_SEARCH_RESULT]\nerror=${code}`.slice(0, maxChars);
    }
    const lines = ['[VCC_SERVER_WEB_SEARCH_RESULT]'];
    for (const item of block.content) {
      if (item?.type !== 'web_search_result') continue;
      const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
      const url = String(item?.url || '').trim();
      const age = item?.page_age ? ` | ${String(item.page_age).slice(0, 120)}` : '';
      lines.push(`- ${title || '(untitled)'} | ${url}${age}`);
      if (lines.join('\n').length >= maxChars) break;
    }
    return lines.join('\n').slice(0, maxChars);
  }
  if (block?.type === 'web_fetch_tool_result') {
    const content = block?.content;
    if (content?.type === 'web_fetch_tool_result_error') {
      return `[VCC_SERVER_WEB_FETCH_RESULT]\nerror=${String(content.error_code || 'unavailable')}`.slice(0, maxChars);
    }
    const url = String(content?.url || '').trim();
    const title = String(content?.content?.title || '').replace(/\s+/g, ' ').trim();
    const data = String(content?.content?.source?.data || '');
    return [`[VCC_SERVER_WEB_FETCH_RESULT]`, `url=${url}`, ...(title ? [`title=${title}`] : []), data]
      .join('\n').slice(0, maxChars);
  }
  return '';
}

export function sanitizeCompletedServerWebHistory(messages, { maxEvidenceChars = 6000 } = {}) {
  if (!Array.isArray(messages)) return { messages, changed: false, completed_count: 0 };
  let changed = false;
  let completedCount = 0;
  const output = messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return structuredClone(message);
    const resultIds = new Set(message.content
      .filter((block) => NATIVE_WEB_RESULT_TYPES.has(block?.type) && typeof block?.tool_use_id === 'string')
      .map((block) => block.tool_use_id));
    if (resultIds.size === 0) return structuredClone(message);
    const next = [];
    for (const block of message.content) {
      if (block?.type === 'server_tool_use' && resultIds.has(block?.id) && responseServerToolCanonical(block)) {
        changed = true;
        continue;
      }
      if (NATIVE_WEB_RESULT_TYPES.has(block?.type) && resultIds.has(block?.tool_use_id)) {
        changed = true;
        completedCount += 1;
        const text = renderCompletedServerWebEvidence(block, Math.max(256, maxEvidenceChars));
        if (text) next.push({ type: 'text', text });
        continue;
      }
      next.push(structuredClone(block));
    }
    return { ...message, content: next };
  });
  return { messages: output, changed, completed_count: completedCount };
}

function splitRule(rule) {
  const slash = rule.indexOf('/');
  if (slash < 0) return { host: rule, path: '' };
  return { host: rule.slice(0, slash), path: `/${rule.slice(slash + 1)}` };
}

function urlMatchesRule(url, rule) {
  const { host, path } = splitRule(rule);
  const hostname = url.hostname.toLowerCase();
  if (!(hostname === host || hostname.endsWith(`.${host}`))) return false;
  if (!path) return true;
  return url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
}

export function isUrlAllowedByWebPolicy(value, policy = {}) {
  let url;
  try { url = value instanceof URL ? value : new URL(value); } catch { return false; }
  const allowed = Array.isArray(policy.allowedDomains) ? policy.allowedDomains : [];
  const blocked = Array.isArray(policy.blockedDomains) ? policy.blockedDomains : [];
  if (blocked.some((rule) => urlMatchesRule(url, rule))) return false;
  if (allowed.length && !allowed.some((rule) => urlMatchesRule(url, rule))) return false;
  return true;
}
