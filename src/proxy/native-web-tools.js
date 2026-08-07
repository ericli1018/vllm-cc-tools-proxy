import { HttpError } from '../lib/http.js';

const NATIVE_SEARCH_PREFIX = 'web_search_';
const NATIVE_FETCH_PREFIX = 'web_fetch_';
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

function canonicalName(value) {
  if (value === 'WebSearch' || value === 'web_search') return 'WebSearch';
  if (value === 'WebFetch' || value === 'web_fetch') return 'WebFetch';
  return '';
}

function nativeCanonical(tool) {
  const type = typeof tool?.type === 'string' ? tool.type : '';
  if (type.startsWith(NATIVE_SEARCH_PREFIX)) return 'WebSearch';
  if (type.startsWith(NATIVE_FETCH_PREFIX)) return 'WebFetch';
  return '';
}

export function isNativeWebToolDefinition(tool) {
  return Boolean(nativeCanonical(tool));
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
