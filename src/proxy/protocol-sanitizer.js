const CONTROL_TAG_SOURCE = String.raw`<\/?(?:think|thinking|analysis|generated_info|function_result|tool_call|tool_response|arg_key|arg_value|function|parameter)(?:=[^>]+|\s[^>]*)?>|<\|im_(?:start|end)\|>`;

function matcher() { return new RegExp(CONTROL_TAG_SOURCE, 'gi'); }

export function controlTagName(tag) {
  return String(tag ?? '')
    .replace(/[<>/]/g, '')
    .split(/[=\s]/)[0]
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
