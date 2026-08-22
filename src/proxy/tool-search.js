const TOOL_SEARCH_TYPE = /^tool_search_tool_(regex|bm25)(?:_[0-9]{8})?$/;
const TOOL_SEARCH_NAME = /^tool_search_tool_(regex|bm25)$/;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_LOCAL_RESULT_LIMIT = 16;
const MAX_LOCAL_TOOL_SEARCH_ROUNDS = 3;

const CORE_EAGER_NAMES = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'Task',
  'WebSearch', 'WebFetch', 'web_search', 'web_fetch',
  'tool_search_tool_regex', 'tool_search_tool_bm25',
]);

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function searchVariantFromDefinition(tool) {
  const type = cleanText(tool?.type);
  const typeMatch = TOOL_SEARCH_TYPE.exec(type);
  if (typeMatch) return typeMatch[1];
  const nameMatch = TOOL_SEARCH_NAME.exec(cleanText(tool?.name));
  return nameMatch ? nameMatch[1] : '';
}

export function isToolSearchDefinition(tool) {
  return Boolean(searchVariantFromDefinition(tool));
}

export function toolSearchVariantFromName(name) {
  const match = TOOL_SEARCH_NAME.exec(cleanText(name));
  return match ? match[1] : '';
}

export function isToolSearchToolName(name) {
  return Boolean(toolSearchVariantFromName(name));
}

function isCoreEagerTool(tool) {
  const name = cleanText(tool?.name);
  if (CORE_EAGER_NAMES.has(name)) return true;
  const type = cleanText(tool?.type);
  return /^web_(search|fetch)_[0-9]{8}$/.test(type) || Boolean(TOOL_SEARCH_TYPE.exec(type));
}

function withoutDeferLoading(tool) {
  if (!tool || typeof tool !== 'object' || tool.defer_loading === undefined) return structuredClone(tool);
  const copy = structuredClone(tool);
  delete copy.defer_loading;
  return copy;
}

function localToolSearchDefinition(variant) {
  const isRegex = variant === 'regex';
  return {
    name: `tool_search_tool_${variant}`,
    description: isRegex
      ? 'Search deferred tools by case-insensitive regular expression over tool names, descriptions, argument names, and argument descriptions. Use this when the needed tool is not currently visible.'
      : 'Search deferred tools by natural-language relevance over tool names, descriptions, argument names, and argument descriptions. Use this when the needed tool is not currently visible.',
    input_schema: {
      type: 'object',
      properties: {
        [isRegex ? 'pattern' : 'query']: {
          type: 'string',
          description: isRegex ? 'Case-insensitive regular expression for matching available tools.' : 'Natural-language description of the tool capability needed.',
          maxLength: isRegex ? 200 : 500,
        },
        limit: {
          type: 'integer', minimum: 1, maximum: MAX_LOCAL_RESULT_LIMIT,
          description: `Maximum number of matching tools to load. Defaults to ${DEFAULT_RESULT_LIMIT}.`,
        },
      },
      required: [isRegex ? 'pattern' : 'query'],
      additionalProperties: false,
    },
  };
}

function collectSchemaSearchText(schema, output = []) {
  if (!schema || typeof schema !== 'object') return output;
  if (typeof schema.description === 'string') output.push(schema.description);
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, value] of Object.entries(schema.properties)) {
      output.push(name);
      collectSchemaSearchText(value, output);
    }
  }
  if (schema.items) collectSchemaSearchText(schema.items, output);
  if (Array.isArray(schema.anyOf)) for (const item of schema.anyOf) collectSchemaSearchText(item, output);
  if (Array.isArray(schema.oneOf)) for (const item of schema.oneOf) collectSchemaSearchText(item, output);
  if (Array.isArray(schema.allOf)) for (const item of schema.allOf) collectSchemaSearchText(item, output);
  return output;
}

function searchableDocument(tool) {
  const name = cleanText(tool?.name);
  const description = cleanText(tool?.description);
  const schemaParts = collectSchemaSearchText(tool?.input_schema || tool?.inputSchema || {});
  return [name, name, name, description, description, ...schemaParts.map(cleanText)].filter(Boolean).join(' ');
}

function historyToolNames(messages) {
  const names = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const name = cleanText(block?.name);
      if (name) names.add(name);
    }
  }
  return names;
}

export function prepareLocalToolSearchRequest(request) {
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  const searchDefinitions = tools.filter(isToolSearchDefinition);
  if (searchDefinitions.length === 0) {
    return { request, changed: false, state: null };
  }

  const catalog = new Map();
  for (const tool of tools) {
    if (isToolSearchDefinition(tool) || isCoreEagerTool(tool) || tool?.defer_loading !== true) continue;
    const name = cleanText(tool?.name);
    if (!name || catalog.has(name)) continue;
    catalog.set(name, {
      name,
      definition: withoutDeferLoading(tool),
      searchText: searchableDocument(tool),
    });
  }

  const usedNames = historyToolNames(request?.messages);
  const materializedNames = new Set([...usedNames].filter((name) => catalog.has(name)));
  const visibleTools = [];
  for (const tool of tools) {
    const variant = searchVariantFromDefinition(tool);
    if (variant) {
      visibleTools.push(localToolSearchDefinition(variant));
      continue;
    }
    const name = cleanText(tool?.name);
    const deferred = tool?.defer_loading === true && !isCoreEagerTool(tool);
    if (deferred && !materializedNames.has(name)) continue;
    visibleTools.push(withoutDeferLoading(tool));
  }

  const state = {
    enabled: true,
    catalog,
    materializedNames,
    variants: [...new Set(searchDefinitions.map(searchVariantFromDefinition).filter(Boolean))].sort(),
    searchRounds: 0,
    maxSearchRounds: MAX_LOCAL_TOOL_SEARCH_ROUNDS,
    totalDeferredTools: catalog.size,
  };

  return {
    request: { ...request, tools: visibleTools },
    changed: true,
    state,
  };
}

function tokenize(value) {
  return cleanText(value)
    .toLocaleLowerCase('en-US')
    .replace(/[_./:-]+/g, ' ')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function bm25Matches(entries, query, limit) {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];
  const docs = entries.map((entry) => tokenize(entry.searchText));
  const avgLen = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const k1 = 1.2;
  const b = 0.75;
  const scored = entries.map((entry, index) => {
    const doc = docs[index];
    const counts = new Map();
    for (const token of doc) counts.set(token, (counts.get(token) || 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) || 0;
      if (!tf) continue;
      let df = 0;
      for (const candidate of docs) if (candidate.includes(term)) df += 1;
      const idf = Math.log(1 + ((docs.length - df + 0.5) / (df + 0.5)));
      const denom = tf + k1 * (1 - b + b * (doc.length / Math.max(1, avgLen)));
      score += idf * ((tf * (k1 + 1)) / denom);
    }
    const lowerName = entry.name.toLocaleLowerCase('en-US');
    const queryLower = cleanText(query).toLocaleLowerCase('en-US');
    if (queryLower && lowerName.includes(queryLower)) score += 8;
    for (const term of queryTerms) if (lowerName.includes(term)) score += 1.5;
    return { entry, score };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, bScore) => bScore.score - a.score || a.entry.name.localeCompare(bScore.entry.name))
    .slice(0, limit)
    .map((item) => item.entry);
}

function regexMatches(entries, pattern, limit) {
  if (cleanText(pattern).length > 200) {
    return { matches: [], error: { code: 'invalid_tool_input', message: 'ToolSearch regex pattern exceeds 200 characters.' } };
  }
  let expression;
  try {
    expression = new RegExp(String(pattern ?? ''), 'i');
  } catch (error) {
    return { matches: [], error: { code: 'invalid_tool_input', message: `Invalid ToolSearch regular expression: ${cleanText(error?.message)}` } };
  }
  return { matches: entries.filter((entry) => expression.test(entry.searchText)).slice(0, limit), error: null };
}

function requestedLimit(input) {
  const raw = input?.limit;
  if (raw === undefined || raw === null) return DEFAULT_RESULT_LIMIT;
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_RESULT_LIMIT;
  return Math.min(raw, MAX_LOCAL_RESULT_LIMIT);
}

export function executeLocalToolSearch(state, toolUse) {
  const variant = toolSearchVariantFromName(toolUse?.name);
  if (!state?.enabled || !variant) return null;
  const input = toolUse?.input && typeof toolUse.input === 'object' ? toolUse.input : {};
  if (state.searchRounds >= state.maxSearchRounds) {
    return {
      variant,
      query: cleanText(variant === 'regex' ? input.pattern : input.query),
      limit: requestedLimit(input),
      matches: [],
      newlyMaterialized: [],
      error: { code: 'tool_search_budget_exhausted', message: 'Local ToolSearch round budget exhausted.' },
      round: state.searchRounds,
      exhausted: true,
    };
  }
  state.searchRounds += 1;
  const limit = requestedLimit(input);
  const entries = [...state.catalog.values()];
  let matches = [];
  let error = null;
  let searchText = '';
  if (variant === 'regex') {
    searchText = cleanText(input.pattern);
    const result = regexMatches(entries, input.pattern, limit);
    matches = result.matches;
    error = result.error;
  } else {
    searchText = cleanText(input.query);
    if (searchText.length > 500) {
      error = { code: 'invalid_tool_input', message: 'ToolSearch BM25 query exceeds 500 characters.' };
    } else {
      matches = bm25Matches(entries, searchText, limit);
    }
  }

  const newlyMaterialized = [];
  if (!error) {
    for (const match of matches) {
      if (!state.materializedNames.has(match.name)) newlyMaterialized.push(match.name);
      state.materializedNames.add(match.name);
    }
  }

  return {
    variant,
    query: searchText,
    limit,
    matches: error ? [] : matches.map((entry) => entry.name),
    newlyMaterialized,
    error,
    round: state.searchRounds,
    exhausted: state.searchRounds >= state.maxSearchRounds,
  };
}

function toolDefinitionByName(state, name) {
  return state?.catalog?.get(name)?.definition || null;
}

export function materializeLocalToolSearchTools(request, state, { disableSearch = false } = {}) {
  if (!state?.enabled || !Array.isArray(request?.tools)) return request;
  const visible = [];
  const seen = new Set();
  for (const tool of request.tools) {
    const name = cleanText(tool?.name);
    if (disableSearch && isToolSearchToolName(name)) continue;
    if (name) seen.add(name);
    visible.push(tool);
  }
  for (const name of state.materializedNames) {
    if (seen.has(name)) continue;
    const definition = toolDefinitionByName(state, name);
    if (!definition) continue;
    visible.push(structuredClone(definition));
    seen.add(name);
  }
  return { ...request, tools: visible };
}

export function createLocalToolSearchResult(toolUse, result) {
  const content = result?.error
    ? {
      ok: false,
      error_code: result.error.code,
      error_message: result.error.message,
      matched_tools: [],
    }
    : {
      ok: true,
      matched_tools: result.matches,
      loaded_tool_count: result.matches.length,
      search_budget_exhausted: Boolean(result.exhausted),
    };
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    ...(result?.error ? { is_error: true } : {}),
    content: JSON.stringify(content),
  };
}

export function localToolSearchStateSnapshot(state) {
  if (!state?.enabled) return null;
  return {
    variants: state.variants,
    deferred_tool_count: state.totalDeferredTools,
    materialized_tool_count: state.materializedNames.size,
    search_rounds: state.searchRounds,
    max_search_rounds: state.maxSearchRounds,
  };
}
