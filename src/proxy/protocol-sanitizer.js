const CONTROL_TAG_SOURCE = String.raw`<\/?(?:[a-z0-9_-]+:)?(?:think|thinking|analysis|generated_info|function_result|function_results|function_call|function_calls|tool_call|tool_calls|tool_response|tool_responses|tool_result|tool_results|arg_key|arg_value|function|parameter)(?:=[^>]+|\s[^>]*)?>|<\|im_(?:start|end)\|>`;

function matcher() { return new RegExp(CONTROL_TAG_SOURCE, 'gi'); }

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

function visitStrings(value, callback, seen = new WeakSet()) {
  if (typeof value === 'string') {
    callback(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, callback, seen);
    return;
  }
  for (const item of Object.values(value)) visitStrings(item, callback, seen);
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

export function neutralizeProtocolValue(value, seen = new WeakMap()) {
  if (typeof value === 'string') return neutralizeControlTags(value);
  if (!value || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(neutralizeProtocolValue(item, seen));
    return clone;
  }
  const clone = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) clone[key] = neutralizeProtocolValue(item, seen);
  return clone;
}

export function sanitizeProtocolHistory(messages) {
  if (!Array.isArray(messages)) return { messages, changed: false, tags: [] };
  let changed = false;
  const tags = [];
  const output = messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return structuredClone(message);
    const clone = { ...message, content: message.content.map((block) => {
      if (block?.type !== 'thinking' || typeof block.thinking !== 'string') return structuredClone(block);
      const detected = scanControlTags(block.thinking);
      if (detected.length === 0) return structuredClone(block);
      changed = true;
      tags.push(...detected);
      const { signature: _staleSignature, ...unsignedBlock } = block;
      return { ...unsignedBlock, thinking: neutralizeControlTags(block.thinking) };
    }) };
    return clone;
  });
  return { messages: output, changed, tags };
}
