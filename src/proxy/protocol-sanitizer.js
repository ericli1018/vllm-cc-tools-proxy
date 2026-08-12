import { assertRequestStructureDepth } from '../lib/structure-guard.js';
const CONTROL_TAG_SOURCE = String.raw`<\/?(?:[a-z0-9_-]+:)?(?:think|thinking|analysis|generated_info|function_result|function_results|function_call|function_calls|tool_call|tool_calls|tool_response|tool_responses|tool_result|tool_results|arg_key|arg_value|function|parameter)(?:=[^>]+|\s[^>]*)?>|<\|im_(?:start|end)\|>`;

function matcher() { return new RegExp(CONTROL_TAG_SOURCE, 'gi'); }


const RESERVED_RESULT_MARKERS = Object.freeze([
  ['[WEB_SOURCE_CONTENT_BEGIN]', '[WEB_SOURCE_CONTENT_DATA_BEGIN]'],
  ['[WEB_SOURCE_CONTENT_END]', '[WEB_SOURCE_CONTENT_DATA_END]'],
  ['[VCC_WEB_SEARCH_RESULT_BEGIN', '[VCC_WEB_SEARCH_RESULT_DATA_BEGIN'],
  ['[VCC_WEB_SEARCH_RESULT_END]', '[VCC_WEB_SEARCH_RESULT_DATA_END]'],
  ['[VCC_WEB_FETCH_RESULT_BEGIN', '[VCC_WEB_FETCH_RESULT_DATA_BEGIN'],
  ['[VCC_WEB_FETCH_RESULT_END]', '[VCC_WEB_FETCH_RESULT_DATA_END]'],
]);

export function neutralizeReservedResultMarkers(value) {
  let text = String(value ?? '');
  for (const [marker, replacement] of RESERVED_RESULT_MARKERS) text = text.replaceAll(marker, replacement);
  return text;
}

export function controlTagName(tag) {
  return String(tag ?? '')
    .replace(/[<>/]/g, '')
    .split(/[=\s]/)[0]
    .replace(/^[a-z0-9_-]+:/i, '')
    .replace(/^\|im_/, 'im_')
    .replace(/\|$/, '')
    .toLowerCase();
}

export function findControlTags(value) {
  const text = String(value ?? '');
  const found = [];
  for (const match of text.matchAll(matcher())) {
    found.push({ raw: match[0], index: match.index ?? 0, name: controlTagName(match[0]) });
  }
  return found;
}

export function scanControlTags(value) {
  return findControlTags(value).map((item) => item.raw);
}

export function neutralizeControlTags(value) {
  return String(value ?? '').replace(matcher(), (tag) => tag
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;'));
}

function isRawBase64Source(value) {
  return Boolean(value && typeof value === 'object' && value.type === 'base64' && typeof value.data === 'string');
}

function visitStrings(value, callback) {
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    const item = current.value;
    assertRequestStructureDepth(current.depth);
    if (typeof item === 'string') {
      callback(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    const rawBase64 = isRawBase64Source(item);
    const entries = Object.entries(item);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      if (rawBase64 && key === 'data') continue;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export function inventoryProtocolTags(value) {
  const counts = {};
  let total = 0;
  visitStrings(value, (text) => {
    for (const tag of findControlTags(text)) {
      counts[tag.name] = (counts[tag.name] || 0) + 1;
      total += 1;
    }
  });
  return {
    total,
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function neutralizeProtocolValue(value, seen = new WeakMap(), depth = 0) {
  assertRequestStructureDepth(depth);
  if (typeof value === 'string') return neutralizeControlTags(value);
  if (!value || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(neutralizeProtocolValue(item, seen, depth + 1));
    return clone;
  }
  const clone = {};
  seen.set(value, clone);
  const rawBase64 = isRawBase64Source(value);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = rawBase64 && key === 'data' ? item : neutralizeProtocolValue(item, seen, depth + 1);
  }
  return clone;
}

function collectProtocolTags(value) {
  const tags = [];
  visitStrings(value, (text) => tags.push(...scanControlTags(text)));
  return tags;
}

function sanitizeDescriptionFields(value, state, seen = new WeakMap(), depth = 0) {
  assertRequestStructureDepth(depth);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(sanitizeDescriptionFields(item, state, seen, depth + 1));
    return clone;
  }
  const clone = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'description' && typeof item === 'string') {
      const detected = scanControlTags(item);
      if (detected.length > 0) {
        state.changed = true;
        state.tags.push(...detected);
        clone[key] = neutralizeControlTags(item);
      } else {
        clone[key] = item;
      }
      continue;
    }
    clone[key] = sanitizeDescriptionFields(item, state, seen, depth + 1);
  }
  return clone;
}

export function sanitizeProtocolToolDefinitions(tools) {
  if (!Array.isArray(tools)) return { tools, changed: false, tags: [] };
  const state = { changed: false, tags: [] };
  return {
    tools: sanitizeDescriptionFields(tools, state),
    changed: state.changed,
    tags: state.tags,
  };
}


function cloneProtocolValue(value, seen = new WeakMap(), depth = 0) {
  assertRequestStructureDepth(depth);
  if (!value || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (seen.has(value)) return seen.get(value);
  const clone = Array.isArray(value) ? [] : {};
  seen.set(value, clone);
  if (Array.isArray(value)) {
    for (const item of value) clone.push(cloneProtocolValue(item, seen, depth + 1));
  } else {
    for (const [key, item] of Object.entries(value)) clone[key] = cloneProtocolValue(item, seen, depth + 1);
  }
  return clone;
}

export function sanitizeProtocolHistory(messages) {
  if (!Array.isArray(messages)) return { messages, changed: false, tags: [] };
  let changed = false;
  const tags = [];
  const output = messages.map((message) => {
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      return { ...message, content: message.content.map((block) => {
        if (block?.type !== 'thinking' || typeof block.thinking !== 'string') return cloneProtocolValue(block);
        const detected = scanControlTags(block.thinking);
        if (detected.length === 0) return cloneProtocolValue(block);
        changed = true;
        tags.push(...detected);
        const { signature: _staleSignature, ...unsignedBlock } = block;
        return { ...unsignedBlock, thinking: neutralizeControlTags(block.thinking) };
      }) };
    }

    if (message?.role === 'user' && Array.isArray(message.content)) {
      return { ...message, content: message.content.map((block) => {
        if (block?.type !== 'tool_result' || block.content === undefined) return cloneProtocolValue(block);
        const detected = collectProtocolTags(block.content);
        if (detected.length === 0) return cloneProtocolValue(block);
        changed = true;
        tags.push(...detected);
        return { ...cloneProtocolValue(block), content: neutralizeProtocolValue(block.content) };
      }) };
    }

    if (message?.role === 'tool' && message.content !== undefined) {
      const detected = collectProtocolTags(message.content);
      if (detected.length === 0) return cloneProtocolValue(message);
      changed = true;
      tags.push(...detected);
      return { ...cloneProtocolValue(message), content: neutralizeProtocolValue(message.content) };
    }

    return cloneProtocolValue(message);
  });
  return { messages: output, changed, tags };
}
