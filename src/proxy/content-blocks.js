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

async function adaptBlock(block, adapters, context) {
  if (!block || typeof block !== 'object') return block;

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
      }));
    }
  }
  return clone;
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
        }));
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
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (isBase64Source(value, 'document') && value.source.media_type === 'application/pdf') count.documents += 1;
    if (isBase64Source(value, 'image') && value.source.media_type.startsWith('image/')) count.images += 1;
    if (Array.isArray(value.content)) walk(value.content);
  };
  walk(messages);
  return count;
}
