import { HttpError } from '../lib/http.js';

function parseSseBlock(block) {
  let name = 'message';
  const data = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { name, data: data.join('\n') };
}

function invalidStream(message, details = undefined) {
  return new HttpError(502, message, {
    code: 'vllm_invalid_stream', retryable: true, ...(details ? { details } : {}),
  });
}

function parsePayload(parsed) {
  if (!parsed.data) return null;
  try { return JSON.parse(parsed.data); } catch {
    throw invalidStream('vLLM returned malformed Anthropic SSE JSON.', {
      event: parsed.name,
      data_prefix: parsed.data.slice(0, 200),
    });
  }
}

function mergeUsage(base, update) {
  if (!update || typeof update !== 'object') return base || {};
  return { ...(base || {}), ...update };
}

function ensureBlock(blocks, index) {
  if (!Number.isInteger(index) || index < 0 || !blocks.has(index)) {
    throw invalidStream('vLLM Anthropic SSE referenced an unknown content block.', { index });
  }
  return blocks.get(index);
}

function applyDelta(block, delta, toolJson) {
  if (!delta || typeof delta !== 'object') return;
  if (delta.type === 'text_delta') {
    block.text = `${block.text || ''}${delta.text || ''}`;
    return;
  }
  if (delta.type === 'thinking_delta') {
    block.thinking = `${block.thinking || ''}${delta.thinking || ''}`;
    return;
  }
  if (delta.type === 'signature_delta') {
    block.signature = `${block.signature || ''}${delta.signature || ''}`;
    return;
  }
  if (delta.type === 'input_json_delta') {
    toolJson.value += String(delta.partial_json || '');
    return;
  }
  if (delta.type === 'citations_delta' && delta.citation) {
    block.citations = Array.isArray(block.citations) ? block.citations : [];
    block.citations.push(structuredClone(delta.citation));
  }
}

function finalizeToolInput(block, partialJson, index) {
  if (!partialJson) return;
  try {
    block.input = JSON.parse(partialJson);
  } catch {
    throw invalidStream('vLLM returned malformed tool input JSON in Anthropic SSE.', {
      index,
      partial_json_prefix: partialJson.slice(0, 200),
    });
  }
}

export async function collectAnthropicMessageFromSse(upstream, {
  onFirstEvent = () => {}, onUsage = () => {}, onComplete = () => {}, onStreamPhase = () => {}, onSemanticDelta = () => {}, onCheckpoint = () => {},
} = {}) {
  if (!upstream?.body) throw invalidStream('vLLM Anthropic SSE response did not contain a body.');

  const decoder = new TextDecoder();
  let buffer = '';
  let message = null;
  const blocks = new Map();
  const toolJson = new Map();
  let sawMessageStop = false;
  let firstModelEventObserved = false;
  let currentStreamPhase = 'waiting';
  const completedIndexes = new Set();
  let openIndex = null;

  const checkpointSnapshot = () => {
    const completedBlocks = [...completedIndexes]
      .sort((a, b) => a - b)
      .map((index) => structuredClone(blocks.get(index)))
      .filter(Boolean);
    let partialBlock = null;
    if (Number.isInteger(openIndex) && !completedIndexes.has(openIndex) && blocks.has(openIndex)) {
      const block = blocks.get(openIndex) || {};
      partialBlock = {
        index: openIndex,
        type: String(block.type || 'unknown'),
        ...(block.id ? { id: String(block.id) } : {}),
        ...(block.name ? { name: String(block.name) } : {}),
      };
    }
    return {
      phase: currentStreamPhase,
      completed_blocks: completedBlocks,
      partial_block: partialBlock,
    };
  };

  const notifyCheckpoint = async () => {
    try { await onCheckpoint(checkpointSnapshot()); } catch {}
  };

  const notifyStreamPhase = async ({ event = '', blockType = '', deltaType = '' } = {}) => {
    const phase = (blockType === 'thinking' || deltaType === 'thinking_delta') ? 'thinking'
      : (blockType === 'tool_use' || blockType === 'server_tool_use' || deltaType === 'input_json_delta') ? 'tool'
        : (blockType === 'text' || deltaType === 'text_delta') ? 'response' : null;
    if (!phase || phase === currentStreamPhase) return;
    const previousPhase = currentStreamPhase;
    currentStreamPhase = phase;
    try {
      await onStreamPhase({
        phase, previous_phase: previousPhase, event, block_type: blockType, delta_type: deltaType,
      });
    } catch {}
  };

  const processBlock = async (rawBlock) => {
    if (!String(rawBlock || '').trim()) return;
    const parsed = parseSseBlock(rawBlock);
    const payload = parsePayload(parsed);

    if (parsed.name === 'ping') return;
    if (parsed.name === 'error' || payload?.type === 'error') {
      const upstreamError = payload?.error || {};
      throw new HttpError(502, upstreamError.message || 'Base vLLM returned an Anthropic SSE error.', {
        code: upstreamError.type || 'vllm_stream_error', retryable: true, details: upstreamError,
      });
    }

    if (parsed.name === 'message_start') {
      const started = payload?.message;
      if (!started || typeof started !== 'object') throw invalidStream('vLLM Anthropic SSE message_start did not contain a message.');
      message = structuredClone(started);
      try { await onUsage({ stage: 'message_start', usage: structuredClone(message.usage || {}) }); } catch {}
      const initialContent = Array.isArray(message.content) ? message.content : [];
      message.content = [];
      initialContent.forEach((entry, index) => blocks.set(index, structuredClone(entry)));
      return;
    }

    if (parsed.name === 'content_block_start') {
      if (!message) throw invalidStream('vLLM Anthropic SSE started content before message_start.');
      const index = payload?.index;
      const block = payload?.content_block;
      if (!Number.isInteger(index) || !block || typeof block !== 'object') {
        throw invalidStream('vLLM Anthropic SSE content_block_start was invalid.');
      }
      blocks.set(index, structuredClone(block));
      openIndex = index;
      if (!firstModelEventObserved) {
        firstModelEventObserved = true;
        try { await onFirstEvent({ event: parsed.name, type: payload?.type || '', block_type: block.type || '' }); } catch {}
      }
      await notifyStreamPhase({ event: parsed.name, blockType: block.type || '' });
      if (block.type === 'tool_use' || block.type === 'server_tool_use') toolJson.set(index, '');
      await notifyCheckpoint();
      return;
    }

    if (parsed.name === 'content_block_delta') {
      const index = payload?.index;
      const block = ensureBlock(blocks, index);
      const delta = payload?.delta || {};
      let semanticValue = '';
      let semanticType = '';
      if (delta.type === 'thinking_delta') {
        semanticValue = typeof delta.thinking === 'string' ? delta.thinking : '';
        semanticType = 'thinking';
      } else if (delta.type === 'text_delta') {
        semanticValue = typeof delta.text === 'string' ? delta.text : '';
        semanticType = 'text';
      } else if (delta.type === 'input_json_delta') {
        semanticValue = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        semanticType = 'tool_json';
      }
      if (semanticValue) {
        try {
          await onSemanticDelta({
            type: semanticType,
            bytes: Buffer.byteLength(semanticValue, 'utf8'),
            index,
          });
        } catch {}
      }
      if (!firstModelEventObserved) {
        firstModelEventObserved = true;
        try { await onFirstEvent({ event: parsed.name, type: payload?.type || '', block_type: block.type || '' }); } catch {}
      }
      await notifyStreamPhase({
        event: parsed.name, blockType: block.type || '', deltaType: payload?.delta?.type || '',
      });
      const holder = { value: toolJson.get(index) || '' };
      applyDelta(block, payload?.delta, holder);
      if (toolJson.has(index)) toolJson.set(index, holder.value);
      return;
    }

    if (parsed.name === 'content_block_stop') {
      const index = payload?.index;
      const block = ensureBlock(blocks, index);
      if (toolJson.has(index)) {
        finalizeToolInput(block, toolJson.get(index), index);
        toolJson.delete(index);
      }
      completedIndexes.add(index);
      if (openIndex === index) openIndex = null;
      await notifyCheckpoint();
      return;
    }

    if (parsed.name === 'message_delta') {
      if (!message) throw invalidStream('vLLM Anthropic SSE returned message_delta before message_start.');
      if (payload?.delta && typeof payload.delta === 'object') Object.assign(message, payload.delta);
      message.usage = mergeUsage(message.usage, payload?.usage);
      if (payload?.usage) {
        try { await onUsage({ stage: 'message_delta', usage: structuredClone(payload.usage) }); } catch {}
      }
      return;
    }

    if (parsed.name === 'message_stop') {
      sawMessageStop = true;
    }
  };

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const rawBlock = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      await processBlock(rawBlock);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await processBlock(buffer);

  if (!message) throw invalidStream('vLLM Anthropic SSE ended without message_start.');
  for (const [index, partial] of toolJson.entries()) finalizeToolInput(ensureBlock(blocks, index), partial, index);
  message.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  message.usage = message.usage || {};
  if (!sawMessageStop) throw invalidStream('vLLM Anthropic SSE ended without message_stop.');
  try { await onComplete({ firstModelEventObserved }); } catch {}
  return message;
}
