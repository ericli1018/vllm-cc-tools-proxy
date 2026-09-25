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

const TOOL_INPUT_LOOP_PROFILES = Object.freeze({
  aggressive: Object.freeze({
    name: 'aggressive',
    minBytes: 8_192,
    checkStepBytes: 2_048,
    maxTailBytes: 24_576,
    minPeriodTokens: 4,
    maxPeriodTokens: 128,
    minSequenceBytes: 128,
    minCycles: 3,
    confirmGrowthBytes: 4_096,
  }),
  default: Object.freeze({
    name: 'default',
    minBytes: 12_288,
    checkStepBytes: 3_072,
    maxTailBytes: 32_768,
    minPeriodTokens: 4,
    maxPeriodTokens: 160,
    minSequenceBytes: 160,
    minCycles: 4,
    confirmGrowthBytes: 6_144,
  }),
  generated_content: Object.freeze({
    name: 'generated_content',
    minBytes: 32_768,
    checkStepBytes: 4_096,
    maxTailBytes: 65_536,
    minPeriodTokens: 4,
    maxPeriodTokens: 256,
    minSequenceBytes: 256,
    minCycles: 8,
    confirmGrowthBytes: 8_192,
  }),
});

const GENERATED_CONTENT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

function toolInputLoopProfile(toolName) {
  const name = String(toolName || '');
  if (GENERATED_CONTENT_TOOLS.has(name)) return TOOL_INPUT_LOOP_PROFILES.generated_content;
  if (name === 'Bash') return TOOL_INPUT_LOOP_PROFILES.aggressive;
  return TOOL_INPUT_LOOP_PROFILES.default;
}

function toolInputLoopError(details) {
  return new HttpError(502, 'vLLM tool input entered a repetitive generation loop.', {
    code: 'vllm_tool_input_loop_detected', retryable: true, details,
  });
}

function loopTokens(value) {
  return String(value || '').match(/[A-Za-z0-9_./:@%+=~-]+|[^\s]/g) || [];
}

function rotationsEqual(left = [], right = []) {
  if (left.length !== right.length || !left.length) return false;
  for (let shift = 0; shift < left.length; shift += 1) {
    if (left[shift] !== right[0]) continue;
    let same = true;
    for (let index = 0; index < left.length; index += 1) {
      if (left[(shift + index) % left.length] !== right[index]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

function repeatedCycle(value, profile) {
  const tail = boundedUtf8Tail(value, profile.maxTailBytes);
  const tokens = loopTokens(tail);
  const maxPeriod = Math.min(profile.maxPeriodTokens, Math.floor(tokens.length / profile.minCycles));
  for (let period = profile.minPeriodTokens; period <= maxPeriod; period += 1) {
    const span = period * profile.minCycles;
    const start = tokens.length - span;
    let same = true;
    for (let cycle = 1; cycle < profile.minCycles && same; cycle += 1) {
      for (let offset = 0; offset < period; offset += 1) {
        if (tokens[start + offset] !== tokens[start + (cycle * period) + offset]) {
          same = false;
          break;
        }
      }
    }
    if (!same) continue;
    const sequenceTokens = tokens.slice(tokens.length - period);
    const sequence = sequenceTokens.join(' ');
    const sequenceBytes = Buffer.byteLength(sequence, 'utf8');
    if (sequenceBytes < profile.minSequenceBytes) continue;
    return {
      repeated_period_tokens: period,
      repeated_sequence_bytes: sequenceBytes,
      repeated_cycles: profile.minCycles,
      sequence_tokens: sequenceTokens,
    };
  }
  return null;
}

function confirmSustainedLoop(value, detectorState, profile) {
  const bytes = Buffer.byteLength(String(value || ''), 'utf8');
  if (bytes < profile.minBytes) return null;
  if (bytes - Number(detectorState?.last_checked_bytes || 0) < profile.checkStepBytes) return null;
  if (detectorState) detectorState.last_checked_bytes = bytes;

  const cycle = repeatedCycle(value, profile);
  if (!cycle) {
    if (detectorState) detectorState.suspicion = null;
    return null;
  }

  const previous = detectorState?.suspicion || null;
  const sameCycle = previous
    && previous.repeated_period_tokens === cycle.repeated_period_tokens
    && rotationsEqual(previous.sequence_tokens, cycle.sequence_tokens);

  if (!sameCycle) {
    if (detectorState) {
      detectorState.suspicion = {
        first_observed_bytes: bytes,
        repeated_period_tokens: cycle.repeated_period_tokens,
        repeated_sequence_bytes: cycle.repeated_sequence_bytes,
        sequence_tokens: cycle.sequence_tokens,
      };
    }
    return null;
  }

  const growthBytes = bytes - Number(previous.first_observed_bytes || bytes);
  if (growthBytes < profile.confirmGrowthBytes) return null;

  return {
    repeated_period_tokens: cycle.repeated_period_tokens,
    repeated_sequence_bytes: cycle.repeated_sequence_bytes,
    repeated_cycles: cycle.repeated_cycles,
    first_observed_bytes: previous.first_observed_bytes,
    confirmed_growth_bytes: growthBytes,
    confirmation_stage: 'sustained',
    detector_profile: profile.name,
  };
}

function detectToolInputLoop(partialJson, detectorState, toolName) {
  const profile = toolInputLoopProfile(toolName);
  const confirmed = confirmSustainedLoop(partialJson, detectorState, profile);
  return confirmed ? {
    ...confirmed,
    partial_json_bytes: Buffer.byteLength(String(partialJson || ''), 'utf8'),
  } : null;
}

const SEMANTIC_LOOP_PROFILES = Object.freeze({
  thinking: Object.freeze({
    name: 'thinking',
    minBytes: 16_384,
    checkStepBytes: 4_096,
    maxTailBytes: 32_768,
    minPeriodTokens: 6,
    maxPeriodTokens: 192,
    minSequenceBytes: 160,
    minCycles: 5,
    confirmGrowthBytes: 4_096,
  }),
  response: Object.freeze({
    name: 'response',
    minBytes: 12_288,
    checkStepBytes: 4_096,
    maxTailBytes: 32_768,
    minPeriodTokens: 4,
    maxPeriodTokens: 192,
    minSequenceBytes: 160,
    minCycles: 6,
    confirmGrowthBytes: 4_096,
  }),
});

function semanticLoopError(kind, details) {
  const label = kind === 'thinking' ? 'thinking' : 'visible response';
  return new HttpError(502, `vLLM ${label} entered a repetitive generation loop.`, {
    code: kind === 'thinking' ? 'vllm_thinking_loop_detected' : 'vllm_response_loop_detected',
    retryable: true,
    details: { stream_kind: kind, ...details },
  });
}

function detectSemanticLoop(kind, value, detectorState) {
  const profile = SEMANTIC_LOOP_PROFILES[kind];
  if (!profile) return null;
  const confirmed = confirmSustainedLoop(value, detectorState, profile);
  return confirmed ? {
    ...confirmed,
    accumulated_bytes: Buffer.byteLength(String(value || ''), 'utf8'),
  } : null;
}

function boundedUtf8Tail(value, maxBytes = 1024) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.byteLength <= maxBytes) return buffer.toString('utf8');
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function finalizeToolInput(block, partialJson, index) {
  if (!partialJson) return;
  try {
    block.input = JSON.parse(partialJson);
  } catch {
    throw invalidStream('vLLM returned malformed tool input JSON in Anthropic SSE.', {
      index,
      tool_name: String(block?.name || ''),
      partial_json_bytes: Buffer.byteLength(partialJson, 'utf8'),
      partial_json_prefix: partialJson.slice(0, 200),
      partial_json_tail: boundedUtf8Tail(partialJson),
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
  const toolLoopState = new Map();
  const semanticLoopState = new Map();
  let sawMessageStop = false;
  let deferredMalformedToolError = null;
  let firstModelEventObserved = false;
  let currentStreamPhase = 'waiting';
  const completedIndexes = new Set();
  let openIndex = null;
  const eventCounts = Object.create(null);
  const eventSequence = [];
  const MAX_EVENT_FINGERPRINT_ITEMS = 32;

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

    if (parsed.name !== 'ping') {
      eventCounts[parsed.name] = (eventCounts[parsed.name] || 0) + 1;
      if (eventSequence.length < MAX_EVENT_FINGERPRINT_ITEMS) eventSequence.push(parsed.name);
    }
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
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        toolJson.set(index, '');
        toolLoopState.set(index, { last_checked_bytes: 0 });
      } else if (block.type === 'thinking' || block.type === 'text') {
        semanticLoopState.set(index, { last_checked_bytes: 0 });
      }
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
            value: semanticValue,
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
      if (toolJson.has(index)) {
        toolJson.set(index, holder.value);
        if (delta.type === 'input_json_delta') {
          const loop = detectToolInputLoop(holder.value, toolLoopState.get(index), block?.name);
          if (loop) {
            await notifyCheckpoint();
            throw toolInputLoopError({
              index,
              tool_name: String(block?.name || ''),
              ...loop,
              partial_json_tail: boundedUtf8Tail(holder.value),
            });
          }
        }
      }
      if (delta.type === 'thinking_delta' || delta.type === 'text_delta') {
        const kind = delta.type === 'thinking_delta' ? 'thinking' : 'response';
        const accumulated = kind === 'thinking' ? String(block.thinking || '') : String(block.text || '');
        const loop = detectSemanticLoop(kind, accumulated, semanticLoopState.get(index));
        if (loop) {
          await notifyCheckpoint();
          throw semanticLoopError(kind, {
            index,
            ...loop,
            repeated_tail: boundedUtf8Tail(accumulated),
          });
        }
      }
      return;
    }

    if (parsed.name === 'content_block_stop') {
      const index = payload?.index;
      const block = ensureBlock(blocks, index);
      let malformedToolInput = false;
      if (toolJson.has(index)) {
        try {
          finalizeToolInput(block, toolJson.get(index), index);
        } catch (error) {
          if (error?.code !== 'vllm_invalid_stream') throw error;
          if (!deferredMalformedToolError) deferredMalformedToolError = error;
          malformedToolInput = true;
        }
        toolJson.delete(index);
        toolLoopState.delete(index);
      }
      semanticLoopState.delete(index);
      if (!malformedToolInput) {
        completedIndexes.add(index);
        if (openIndex === index) openIndex = null;
      }
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
  for (const [index, partial] of toolJson.entries()) {
    try {
      finalizeToolInput(ensureBlock(blocks, index), partial, index);
    } catch (error) {
      if (error?.code !== 'vllm_invalid_stream') throw error;
      if (!deferredMalformedToolError) deferredMalformedToolError = error;
    }
  }
  message.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  message.usage = message.usage || {};
  if (deferredMalformedToolError) {
    deferredMalformedToolError.details = {
      ...(deferredMalformedToolError.details || {}),
      stop_reason: message.stop_reason ?? null,
      output_tokens: Number.isFinite(Number(message.usage?.output_tokens)) ? Number(message.usage.output_tokens) : null,
    };
    throw deferredMalformedToolError;
  }
  if (!sawMessageStop) throw invalidStream('vLLM Anthropic SSE ended without message_stop.');
  try {
    await onComplete({
      firstModelEventObserved,
      event_sequence: [...eventSequence],
      event_counts: Object.fromEntries(Object.entries(eventCounts)),
      content_block_count: blocks.size,
      fingerprint_truncated: eventSequence.length >= MAX_EVENT_FINGERPRINT_ITEMS,
    });
  } catch {}
  return message;
}
