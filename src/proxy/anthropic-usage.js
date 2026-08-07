const TOKEN_FIELDS = Object.freeze([
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
]);

function nonNegativeInteger(value, fallback = undefined) {
  if (Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

function normalizeServerToolUse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized = {};
  for (const [key, count] of Object.entries(value)) {
    const safeCount = nonNegativeInteger(count);
    if (safeCount !== undefined) normalized[key] = safeCount;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export function normalizeAnthropicUsage(value, {
  defaultInputTokens = 0,
  defaultOutputTokens = 0,
  includeZeroCacheFields = false,
} = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {
    input_tokens: nonNegativeInteger(source.input_tokens, defaultInputTokens),
    output_tokens: nonNegativeInteger(source.output_tokens, defaultOutputTokens),
  };

  for (const field of TOKEN_FIELDS.slice(1, 3)) {
    const count = nonNegativeInteger(source[field]);
    if (count !== undefined) normalized[field] = count;
    else if (includeZeroCacheFields) normalized[field] = 0;
  }

  const serverToolUse = normalizeServerToolUse(source.server_tool_use);
  if (serverToolUse) normalized.server_tool_use = serverToolUse;
  return normalized;
}

export function usageFromTokenCount(payload) {
  return normalizeAnthropicUsage(payload, {
    defaultInputTokens: 0,
    defaultOutputTokens: 0,
    includeZeroCacheFields: true,
  });
}

export function totalAnthropicInputTokens(usage) {
  const normalized = normalizeAnthropicUsage(usage);
  return normalized.input_tokens
    + (normalized.cache_creation_input_tokens || 0)
    + (normalized.cache_read_input_tokens || 0);
}
