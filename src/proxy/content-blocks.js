import { enterRequestStructure } from '../lib/structure-guard.js';

function isBase64Source(block, expectedType) {
  return block?.type === expectedType
    && block?.source?.type === 'base64'
    && typeof block.source.media_type === 'string'
    && typeof block.source.data === 'string';
}

function isProxyFileSource(block, expectedType) {
  return block?.type === expectedType
    && block?.source?.type === 'proxy_file'
    && typeof block.source.media_type === 'string'
    && typeof block.source.path === 'string';
}

async function adaptBlock(block, adapters, context, depth = 0, ancestors = new WeakSet()) {
  if (!block || typeof block !== 'object') return block;
  const leave = enterRequestStructure(block, ancestors, depth);
  try {

  if ((isBase64Source(block, 'document') || isProxyFileSource(block, 'document')) && block.source.media_type === 'application/pdf') {
    if (typeof adapters.adaptDocument !== 'function') return structuredClone(block);
    return adapters.adaptDocument(structuredClone(block), context);
  }

  if ((isBase64Source(block, 'image') || isProxyFileSource(block, 'image')) && block.source.media_type.startsWith('image/')) {
    if (typeof adapters.adaptImage !== 'function') return structuredClone(block);
    return adapters.adaptImage(structuredClone(block), context);
  }

  const clone = { ...block };
  if (Array.isArray(block.content)) {
    clone.content = [];
    for (let index = 0; index < block.content.length; index += 1) {
      clone.content.push(await adaptBlock(block.content[index], adapters, {
        ...context,
        path: [...context.path, 'content', index],
        parentType: block.type,
        toolUseId: block.tool_use_id || context.toolUseId,
      }, depth + 1, ancestors));
    }
  }
  return clone;
  } finally {
    leave();
  }
}

export async function adaptMessages(messages, adapters = {}) {
  if (!Array.isArray(messages)) return messages;
  const output = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const clone = { ...message };
    if (Array.isArray(message.content)) {
      clone.content = [];
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
        clone.content.push(await adaptBlock(message.content[blockIndex], adapters, {
          messageIndex,
          path: ['messages', messageIndex, 'content', blockIndex],
          role: message.role,
          parentType: null,
          toolUseId: null,
        }, 0, new WeakSet()));
      }
    } else if (typeof message.content === 'string') {
      clone.content = message.content;
    }
    output.push(clone);
  }
  return output;
}

export function countAdaptableMedia(messages) {
  const count = { documents: 0, images: 0 };
  const ancestors = new WeakSet();
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object') return;
    const leave = enterRequestStructure(value, ancestors, depth);
    try {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      if (isBase64Source(value, 'document') && value.source.media_type === 'application/pdf') count.documents += 1;
      if (isBase64Source(value, 'image') && value.source.media_type.startsWith('image/')) count.images += 1;
      if (Array.isArray(value.content)) walk(value.content, depth + 1);
    } finally {
      leave();
    }
  };
  walk(messages);
  return count;
}
