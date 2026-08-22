import crypto from 'node:crypto';

const NATIVE_WEB_SEARCH = /^web_search_[0-9]{8}$/;
const NATIVE_WEB_FETCH = /^web_fetch_[0-9]{8}$/;
const TOOL_SEARCH = /^tool_search_tool_(regex|bm25)(?:_[0-9]{8})?$/;
const CODE_EXECUTION = /^code_execution(?:_[0-9]{8})?$/;
const ADVISOR = /^advisor(?:_[0-9]{8})?$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function cleanName(value, max = 160) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function requestDefinition(tool) {
  const type = cleanName(tool?.type);
  if (!type) return null;
  if (NATIVE_WEB_SEARCH.test(type)) return { family: 'web_search', status: 'bridged', type, variant: '' };
  if (NATIVE_WEB_FETCH.test(type)) return { family: 'web_fetch', status: 'bridged', type, variant: '' };
  const search = TOOL_SEARCH.exec(type);
  if (search) return { family: 'tool_search', status: 'local_bridge', type, variant: search[1] };
  if (CODE_EXECUTION.test(type)) return { family: 'code_execution', status: 'unsupported', type, variant: '' };
  if (ADVISOR.test(type)) return { family: 'advisor', status: 'unsupported', type, variant: '' };
  if (type === 'mcp_toolset') return { family: 'mcp_toolset', status: 'unsupported', type, variant: '' };
  return null;
}

function responseServerToolName(name) {
  const value = cleanName(name);
  if (value === 'web_search') return { family: 'web_search', status: 'bridged', variant: '' };
  if (value === 'web_fetch') return { family: 'web_fetch', status: 'bridged', variant: '' };
  const search = /^tool_search_tool_(regex|bm25)$/.exec(value);
  if (search) return { family: 'tool_search', status: 'local_bridge', variant: search[1] };
  if (value === 'code_execution') return { family: 'code_execution', status: 'unsupported', variant: '' };
  if (value === 'advisor') return { family: 'advisor', status: 'unsupported', variant: '' };
  return { family: 'unknown', status: 'unknown', variant: '' };
}

function catalogFingerprint(tools) {
  const catalog = tools.map((tool) => ({
    name: cleanName(tool?.name),
    type: cleanName(tool?.type),
    defer_loading: tool?.defer_loading === true,
  }));
  return sha256(JSON.stringify(catalog));
}

export function inspectAnthropicServerCapabilities(request) {
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  const definitions = [];
  for (let index = 0; index < tools.length; index += 1) {
    const classified = requestDefinition(tools[index]);
    if (!classified) continue;
    definitions.push({
      ...classified,
      index,
      name: cleanName(tools[index]?.name),
    });
  }

  const toolSearch = definitions.filter((entry) => entry.family === 'tool_search');
  const unsupported = definitions.filter((entry) => entry.status === 'unsupported');
  const bridged = definitions.filter((entry) => entry.status === 'bridged');
  const localBridge = definitions.filter((entry) => entry.status === 'local_bridge');
  const deferredToolCount = tools.filter((tool) => tool?.defer_loading === true).length;
  const variants = [...new Set(toolSearch.map((entry) => entry.variant).filter(Boolean))].sort();

  return {
    server_tool_count: definitions.length,
    bridged_count: bridged.length,
    tool_search_count: toolSearch.length,
    discovery_only_count: definitions.filter((entry) => entry.status === 'discovery_only').length,
    local_bridge_count: localBridge.length,
    unsupported_count: unsupported.length,
    unsupported_families: [...new Set(unsupported.map((entry) => entry.family))].sort(),
    definitions,
    ...(toolSearch.length > 0 ? {
      tool_search: {
        variants,
        deferred_tool_count: deferredToolCount,
        eager_tool_count: tools.length - deferredToolCount,
        total_tool_count: tools.length,
        tool_catalog_sha256: catalogFingerprint(tools),
      },
    } : {}),
  };
}

function visit(value, callback, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback, seen);
    return;
  }
  for (const item of Object.values(value)) visit(item, callback, seen);
}

export function inspectAnthropicServerResponse(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const serverToolUses = [];
  const unknownServerToolUses = [];
  let toolSearchResultCount = 0;
  const toolReferenceNames = [];

  for (const block of content) {
    if (block?.type === 'server_tool_use') {
      const classification = responseServerToolName(block?.name);
      const entry = {
        id: cleanName(block?.id, 200),
        name: cleanName(block?.name),
        ...classification,
      };
      serverToolUses.push(entry);
      if (classification.status === 'unknown') unknownServerToolUses.push(entry);
    }
    if (block?.type === 'tool_search_tool_result') toolSearchResultCount += 1;
    visit(block, (node) => {
      if (node?.type !== 'tool_reference') return;
      const toolName = cleanName(node?.tool_name, 240);
      if (toolName) toolReferenceNames.push(toolName);
    });
  }

  const uniqueReferenceNames = [...new Set(toolReferenceNames)].sort();
  return {
    server_tool_use_count: serverToolUses.length,
    tool_search_result_count: toolSearchResultCount,
    tool_reference_count: toolReferenceNames.length,
    unknown_server_tool_use_count: unknownServerToolUses.length,
    server_tool_uses: serverToolUses,
    unknown_server_tool_uses: unknownServerToolUses,
    tool_reference_names_sha256: uniqueReferenceNames.length > 0
      ? sha256(JSON.stringify(uniqueReferenceNames))
      : '',
  };
}
