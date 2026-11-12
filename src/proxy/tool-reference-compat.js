// v0.29.79: bridge Anthropic Tool Search references for local backends.
// Never trust a discovered name on its own: a callable tool must have exactly
// one real client-tool definition in THIS request's tools array.
import { HttpError } from '../lib/http.js';

const MAX_REFERENCES = 256;
const MAX_REFERENCE_TEXT_BYTES = 256 * 1024;
const SEARCH_TOOL = /^tool_search_tool_(?:regex|bm25)(?:_\d{8})?$/;
const NAME_RE = /^[A-Za-z0-9_.:\-]{1,256}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function rejected(code, message) {
  return new HttpError(400, message, { code, retryable: false });
}
function referenceName(ref) {
  if (!object(ref) || ref.type !== 'tool_reference' ||
      typeof ref.tool_name !== 'string' || !NAME_RE.test(ref.tool_name)) {
    throw rejected('tool_reference_invalid', 'Tool reference must contain a valid tool_name.');
  }
  return ref.tool_name;
}
function clientDefinition(name, definitions) {
  const matches = definitions.filter(tool => object(tool) && tool.name === name);
  if (matches.length !== 1) {
    throw rejected(matches.length === 0 ? 'tool_reference_missing_definition' : 'tool_reference_ambiguous_definition',
      'Referenced tool must have exactly one matching definition in tools.');
  }
  const tool = matches[0];
  if (tool.type != null && tool.type !== 'custom') {
    throw rejected('tool_reference_not_client_tool', 'Tool reference points to an unsupported server tool.');
  }
  if (!object(tool.input_schema) || typeof tool.input_schema.type !== 'string' || tool.input_schema.type !== 'object') {
    throw rejected('tool_reference_invalid_schema', 'Referenced client tool requires a JSON-object input_schema.');
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    throw rejected('tool_reference_invalid_schema', 'Referenced tool description must be text.');
  }
  return tool;
}
function definitionSummary(tool) {
  // The actual full input schema is supplied as a callable tool definition;
  // a bounded text summary keeps the model aware of the ToolSearch result.
  const description = (tool.description || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  return `[ToolSearch: loaded callable tool ${JSON.stringify(tool.name)}]${description ? `\nDescription: ${description}` : ''}\nIts complete input JSON Schema is available in the request's tools definitions.`;
}

function supportedSearchBlock(block) {
  return block?.type === 'tool_search_tool_result';
}

export function prepareToolReferenceCompatibility(request, { mode = 'compat', protocol = 'anthropic' } = {}) {
  if (!['compat', 'passthrough'].includes(mode)) {
    throw rejected('tool_reference_invalid_mode', 'Invalid tool-reference compatibility mode.');
  }
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  let hasReference = false;
  let hasSearchResult = false;
  let hasSearchCall = false;
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_reference') {
        throw rejected('tool_reference_invalid_location', 'Tool references must be inside ToolSearch results.');
      }
      if (msg.role === 'user' && block?.type === 'tool_result') {
        if (block.content?.type === 'tool_reference') {
          throw rejected('tool_reference_invalid_location', 'Tool references must be content-array entries.');
        }
        if (Array.isArray(block.content) && block.content.some(item => item?.type === 'tool_reference')) hasReference = true;
      }
      if (msg.role === 'assistant' && supportedSearchBlock(block)) hasSearchResult = true;
      if (msg.role === 'assistant' && block?.type === 'server_tool_use' && SEARCH_TOOL.test(String(block.name || ''))) hasSearchCall = true;
    }
  }
  if (!hasReference && !hasSearchResult && !hasSearchCall) return { request, changed: false, referenceCount: 0, materializedCount: 0 };
  if (mode === 'passthrough') {
    if (protocol !== 'anthropic') {
      throw rejected('tool_reference_passthrough_openai', 'Native tool-reference passthrough requires an Anthropic backend.');
    }
    return { request, changed: false, referenceCount: 0, materializedCount: 0 };
  }

  const definitions = Array.isArray(request?.tools) ? request.tools : [];
  const materialized = new Map();
  let referenceCount = 0;
  let summaryBytes = 0;
  const summary = ref => {
    const name = referenceName(ref);
    if (++referenceCount > MAX_REFERENCES) {
      throw rejected('tool_reference_limit', 'Too many tool references in a single request.');
    }
    const definition = clientDefinition(name, definitions);
    materialized.set(name, definition);
    const text = definitionSummary(definition);
    summaryBytes += Buffer.byteLength(text, 'utf8');
    if (summaryBytes > MAX_REFERENCE_TEXT_BYTES) {
      throw rejected('tool_reference_limit', 'Expanded tool references exceed the context safety limit.');
    }
    return { type: 'text', text };
  };
  const newMessages = messages.map(message => {
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const previousSearch = new Set();
    const completedSearch = new Set();
    const blocks = message.content.map(block => {
      if (message.role === 'user' && block?.type === 'tool_result' && Array.isArray(block.content)) {
        let converted = false;
        const parts = block.content.map(part => {
          if (part?.type !== 'tool_reference') return part;
          converted = true;
          return summary(part);
        });
        if (converted) { changed = true; return { ...block, content: parts }; }
      }
      if (message.role === 'assistant' && block?.type === 'server_tool_use' && SEARCH_TOOL.test(String(block.name || ''))) {
        if (typeof block.id !== 'string' || !block.id.trim() || previousSearch.has(block.id)) {
          throw rejected('tool_reference_invalid_history', 'Invalid ToolSearch call identity.');
        }
        previousSearch.add(block.id);
        changed = true;
        return { type: 'text', text: '[ToolSearch lookup performed; the validated results follow in the conversation.]' };
      }
      if (message.role === 'assistant' && supportedSearchBlock(block)) {
        const container = block.content;
        if (!object(container) || container.type !== 'tool_search_tool_search_result' ||
            !Array.isArray(container.tool_references) || typeof block.tool_use_id !== 'string' ||
            !previousSearch.has(block.tool_use_id)) {
          throw rejected('tool_reference_invalid_history', 'ToolSearch result does not match a preceding search call.');
        }
        if (completedSearch.has(block.tool_use_id)) {
          throw rejected('tool_reference_invalid_history', 'Duplicate ToolSearch results in one assistant turn.');
        }
        completedSearch.add(block.tool_use_id);
        changed = true;
        const entries = container.tool_references.map(summary);
        return { type: 'text', text: entries.length
          ? entries.map(entry => entry.text).join('\n\n')
          : '[ToolSearch completed: no tools matched the search.]' };
      }
      return block;
    });
    if ([...previousSearch].some(id => !completedSearch.has(id))) {
      throw rejected('tool_reference_invalid_history', 'ToolSearch lookup has no matching result in the assistant turn.');
    }
    return changed ? { ...message, content: blocks } : message;
  });

  const newTools = definitions.map(tool => materialized.has(tool?.name)
    ? (({ defer_loading, ...rest }) => ({ ...rest, defer_loading: false }))(tool)
    : tool);
  return {
    request: { ...request, messages: newMessages, tools: newTools },
    changed: true,
    referenceCount,
    materializedCount: materialized.size,
  };
}
