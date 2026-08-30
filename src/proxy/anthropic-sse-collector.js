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

const TOOL_JSON_PREVIEW_CHARS = 512;
const TOOL_JSON_PRE_STOP_MAX_EVENTS = 64;
const TOOL_JSON_POST_STOP_MAX_EVENTS = 64;
const TOOL_JSON_POST_STOP_MAX_RAW_BYTES = 16384;

function jsonErrorPosition(error) {
  const match = String(error?.message || '').match(/position\s+(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function countTopLevelObjectCandidates(value) {
  const text = String(value || '');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let count = 0;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) count += 1;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) depth -= 1;
  }
  return count;
}

function finalizeToolInput(block, partialJson, index, deltaCount = 0) {
  if (!partialJson) return;
  try {
    block.input = JSON.parse(partialJson);
  } catch (error) {
    const trimmed = String(partialJson).trim();
    throw invalidStream('vLLM returned malformed tool input JSON in Anthropic SSE.', {
      kind: 'tool_input_json_invalid',
      index,
      tool_id: String(block?.id || ''),
      tool_name: String(block?.name || ''),
      partial_json_chars: String(partialJson).length,
      partial_json_bytes: Buffer.byteLength(String(partialJson), 'utf8'),
      partial_json_delta_count: Number(deltaCount || 0),
      partial_json_starts_with_object: trimmed.startsWith('{'),
      partial_json_ends_with_object: trimmed.endsWith('}'),
      candidate_top_level_objects: countTopLevelObjectCandidates(partialJson),
      json_error_position: jsonErrorPosition(error),
      json_error_message: String(error?.message || '').slice(0, 256),
      partial_json_preview_chars: TOOL_JSON_PREVIEW_CHARS,
      partial_json_prefix: String(partialJson).slice(0, TOOL_JSON_PREVIEW_CHARS),
      partial_json_suffix: String(partialJson).slice(-TOOL_JSON_PREVIEW_CHARS),
    });
  }
}

function isToolInputJsonInvalid(error) {
  return error?.code === 'vllm_invalid_stream' && error?.details?.kind === 'tool_input_json_invalid';
}

function jsonParses(value) {
  try { JSON.parse(String(value || '')); return true; } catch { return false; }
}

function toolLifecycleEventMetadata(parsed, payload) {
  const metadata = { event: String(parsed?.name || 'message') };
  if (Number.isInteger(payload?.index)) metadata.index = payload.index;
  if (parsed?.name === 'content_block_start') {
    const block = payload?.content_block;
    if (block && typeof block === 'object') {
      if (block.type) metadata.block_type = String(block.type);
      if (block.name) metadata.tool_name = String(block.name);
      if (block.id) metadata.tool_id = String(block.id);
    }
  } else if (parsed?.name === 'content_block_delta') {
    const delta = payload?.delta;
    if (delta && typeof delta === 'object') {
      if (delta.type) metadata.delta_type = String(delta.type);
      if (delta.type === 'input_json_delta') {
        metadata.partial_json_chars = typeof delta.partial_json === 'string' ? delta.partial_json.length : 0;
      }
    }
  } else if (parsed?.name === 'message_delta' && payload?.delta?.stop_reason) {
    metadata.stop_reason = String(payload.delta.stop_reason);
  }
  return metadata;
}

function appendBoundedToolLifecycle(lifecycle, parsed, payload) {
  if (!lifecycle || lifecycle.eventCount >= TOOL_JSON_PRE_STOP_MAX_EVENTS) {
    if (lifecycle) lifecycle.truncated = true;
    return;
  }
  lifecycle.eventCount += 1;
  lifecycle.eventSequence.push(String(parsed?.name || 'message'));
  lifecycle.eventMetadata.push(toolLifecycleEventMetadata(parsed, payload));
}

function attachPreStopProbeDetails(error, lifecycle) {
  if (!error || !lifecycle) return error;
  error.details = {
    ...(error.details || {}),
    pre_stop_probe_event_count: lifecycle.eventCount,
    pre_stop_probe_event_sequence: [...lifecycle.eventSequence],
    pre_stop_probe_event_metadata: lifecycle.eventMetadata.map((entry) => ({ ...entry })),
    pre_stop_probe_max_events: TOOL_JSON_PRE_STOP_MAX_EVENTS,
    pre_stop_probe_truncated: Boolean(lifecycle.truncated),
  };
  return error;
}

function summarizePostStopShadowTool(shadow, { blockStopped = false } = {}) {
  const partialJson = String(shadow?.partialJson || '');
  const trimmed = partialJson.trim();
  let jsonValid = false;
  let parseErrorPosition = null;
  try {
    JSON.parse(partialJson);
    jsonValid = true;
  } catch (error) {
    parseErrorPosition = jsonErrorPosition(error);
  }
  return {
    index: shadow?.index,
    tool_id: String(shadow?.toolId || ''),
    tool_name: String(shadow?.toolName || ''),
    input_json_delta_count: Number(shadow?.deltaCount || 0),
    partial_json_chars: partialJson.length,
    partial_json_bytes: Buffer.byteLength(partialJson, 'utf8'),
    partial_json_starts_with_object: trimmed.startsWith('{'),
    partial_json_ends_with_object: trimmed.endsWith('}'),
    candidate_top_level_objects: countTopLevelObjectCandidates(partialJson),
    json_valid: jsonValid,
    json_error_position: jsonValid ? null : parseErrorPosition,
    block_stopped: Boolean(blockStopped),
  };
}

function observePostStopShadowTool(probe, parsed, payload) {
  const index = payload?.index;
  if (!Number.isInteger(index) || index === probe.index) return;

  if (parsed?.name === 'content_block_start') {
    const block = payload?.content_block;
    if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
      probe.shadowTools.set(index, {
        index,
        toolId: String(block.id || ''),
        toolName: String(block.name || ''),
        partialJson: '',
        deltaCount: 0,
      });
    }
    return;
  }

  const shadow = probe.shadowTools.get(index);
  if (!shadow) return;
  if (parsed?.name === 'content_block_delta' && payload?.delta?.type === 'input_json_delta') {
    shadow.partialJson += typeof payload.delta.partial_json === 'string' ? payload.delta.partial_json : '';
    shadow.deltaCount += 1;
    return;
  }
  if (parsed?.name === 'content_block_stop') {
    probe.shadowToolSummaries.push(summarizePostStopShadowTool(shadow, { blockStopped: true }));
    probe.shadowTools.delete(index);
  }
}

function attachPostStopProbeDetails(probe, stopReason) {
  const lateJson = probe.lateJson;
  const shadowTools = [
    ...probe.shadowToolSummaries,
    ...[...probe.shadowTools.values()].map((shadow) => summarizePostStopShadowTool(shadow, { blockStopped: false })),
  ].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  probe.error.details = {
    ...(probe.error.details || {}),
    post_stop_probe_stop_reason: stopReason,
    post_stop_probe_event_count: probe.eventCount,
    post_stop_probe_raw_bytes: probe.rawBytes,
    post_stop_probe_event_sequence: [...probe.eventSequence],
    post_stop_probe_event_metadata: probe.eventMetadata.map((entry) => ({ ...entry })),
    post_stop_probe_max_events: TOOL_JSON_POST_STOP_MAX_EVENTS,
    post_stop_probe_max_raw_bytes: TOOL_JSON_POST_STOP_MAX_RAW_BYTES,
    late_same_index_input_json_delta_count: probe.lateDeltaCount,
    late_same_index_partial_json_chars: lateJson.length,
    late_same_index_partial_json_bytes: Buffer.byteLength(lateJson, 'utf8'),
    late_same_index_partial_json_preview_chars: TOOL_JSON_PREVIEW_CHARS,
    late_same_index_partial_json_prefix: lateJson.slice(0, TOOL_JSON_PREVIEW_CHARS),
    late_same_index_partial_json_suffix: lateJson.slice(-TOOL_JSON_PREVIEW_CHARS),
    late_same_index_combined_json_valid: lateJson.length > 0
      ? jsonParses(`${probe.originalPartialJson}${lateJson}`) : false,
    post_stop_shadow_tool_count: shadowTools.length,
    post_stop_shadow_tools: shadowTools,
  };
  return probe.error;
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
  const toolJsonDeltaCounts = new Map();
  const toolJsonLifecycles = new Map();
  let sawMessageStop = false;
  let firstModelEventObserved = false;
  let currentStreamPhase = 'waiting';
  const completedIndexes = new Set();
  let openIndex = null;
  const eventCounts = Object.create(null);
  const eventSequence = [];
  const MAX_EVENT_FINGERPRINT_ITEMS = 32;
  let toolJsonFailureProbe = null;

  const finishToolJsonPostStopProbe = (stopReason) => {
    throw attachPostStopProbeDetails(toolJsonFailureProbe, stopReason);
  };

  const observeToolJsonPostStopProbe = (rawBlock) => {
    const parsed = parseSseBlock(rawBlock);
    toolJsonFailureProbe.eventCount += 1;
    toolJsonFailureProbe.rawBytes += Buffer.byteLength(String(rawBlock || ''), 'utf8');
    if (toolJsonFailureProbe.eventSequence.length < TOOL_JSON_POST_STOP_MAX_EVENTS) {
      toolJsonFailureProbe.eventSequence.push(parsed.name);
    }

    let payload = null;
    if (parsed.data) {
      try { payload = JSON.parse(parsed.data); } catch {}
    }
    if (toolJsonFailureProbe.eventMetadata.length < TOOL_JSON_POST_STOP_MAX_EVENTS) {
      toolJsonFailureProbe.eventMetadata.push(toolLifecycleEventMetadata(parsed, payload));
    }
    observePostStopShadowTool(toolJsonFailureProbe, parsed, payload);
    if (parsed.name === 'content_block_delta'
      && payload?.index === toolJsonFailureProbe.index
      && payload?.delta?.type === 'input_json_delta') {
      const late = typeof payload.delta.partial_json === 'string' ? payload.delta.partial_json : '';
      toolJsonFailureProbe.lateJson += late;
      toolJsonFailureProbe.lateDeltaCount += 1;
    }

    if (parsed.name === 'message_stop' || payload?.type === 'message_stop') {
      finishToolJsonPostStopProbe('message_stop');
    }
    if (toolJsonFailureProbe.eventCount >= TOOL_JSON_POST_STOP_MAX_EVENTS) {
      finishToolJsonPostStopProbe('event_limit');
    }
    if (toolJsonFailureProbe.rawBytes >= TOOL_JSON_POST_STOP_MAX_RAW_BYTES) {
      finishToolJsonPostStopProbe('byte_limit');
    }
  };

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
    if (toolJsonFailureProbe) {
      observeToolJsonPostStopProbe(rawBlock);
      return;
    }
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
        toolJsonDeltaCounts.set(index, 0);
        const lifecycle = { eventCount: 0, eventSequence: [], eventMetadata: [], truncated: false };
        appendBoundedToolLifecycle(lifecycle, parsed, payload);
        toolJsonLifecycles.set(index, lifecycle);
      }
      await notifyCheckpoint();
      return;
    }

    if (parsed.name === 'content_block_delta') {
      const index = payload?.index;
      const block = ensureBlock(blocks, index);
      if (toolJsonLifecycles.has(index)) appendBoundedToolLifecycle(toolJsonLifecycles.get(index), parsed, payload);
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
      if (toolJson.has(index)) {
        toolJson.set(index, holder.value);
        if (payload?.delta?.type === 'input_json_delta') {
          toolJsonDeltaCounts.set(index, (toolJsonDeltaCounts.get(index) || 0) + 1);
        }
      }
      return;
    }

    if (parsed.name === 'content_block_stop') {
      const index = payload?.index;
      const block = ensureBlock(blocks, index);
      if (toolJsonLifecycles.has(index)) appendBoundedToolLifecycle(toolJsonLifecycles.get(index), parsed, payload);
      if (toolJson.has(index)) {
        const partialJson = toolJson.get(index);
        try {
          finalizeToolInput(block, partialJson, index, toolJsonDeltaCounts.get(index) || 0);
        } catch (error) {
          if (!isToolInputJsonInvalid(error)) throw error;
          attachPreStopProbeDetails(error, toolJsonLifecycles.get(index));
          toolJsonFailureProbe = {
            error,
            index,
            originalPartialJson: String(partialJson || ''),
            eventCount: 0,
            rawBytes: 0,
            eventSequence: [],
            eventMetadata: [],
            lateDeltaCount: 0,
            lateJson: '',
            shadowTools: new Map(),
            shadowToolSummaries: [],
          };
          return;
        }
        toolJson.delete(index);
        toolJsonDeltaCounts.delete(index);
        toolJsonLifecycles.delete(index);
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

  if (toolJsonFailureProbe) finishToolJsonPostStopProbe('stream_end');
  if (!message) throw invalidStream('vLLM Anthropic SSE ended without message_start.');
  for (const [index, partial] of toolJson.entries()) {
    finalizeToolInput(ensureBlock(blocks, index), partial, index, toolJsonDeltaCounts.get(index) || 0);
  }
  message.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  message.usage = message.usage || {};
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
