import { formatSseEvent } from './progress.js';
import { findControlTags } from './protocol-sanitizer.js';
import { normalizeAnthropicUsage } from './anthropic-usage.js';
import { statusText } from '../i18n/response-language.js';

function safeToolName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

function responseContent(response) {
  return Array.isArray(response?.content) ? response.content : [];
}

function usageForProgress(progress, observed = {}) {
  if (typeof progress?.usageForDelta === 'function') return progress.usageForDelta(observed);
  return normalizeAnthropicUsage(observed);
}

export function describeFinalAnthropicProgress(response, { locale = 'zh-TW' } = {}) {
  const blocks = responseContent(response);
  const toolNames = blocks
    .filter((block) => block?.type === 'tool_use')
    .map((block) => safeToolName(block?.name))
    .filter(Boolean);
  const common = {
    terminal_for_proxy: true,
    terminal_for_claude_task: false,
    tool_names: toolNames,
  };

  if (toolNames.length > 0) {
    return {
      message: toolNames.length === 1
        ? statusText(locale, 'handoffSingle', { tool: toolNames[0] })
        : statusText(locale, 'handoffMultiple'),
      phase: 'handoff_to_claude_code',
      details: { ...common, response_disposition: 'tool_handoff' },
    };
  }

  const hasVisibleText = blocks.some((block) => block?.type === 'text'
    && typeof block.text === 'string' && block.text.trim());
  if (hasVisibleText) {
    return {
      message: statusText(locale, 'finalVisible'),
      phase: 'returning_visible_response',
      details: { ...common, response_disposition: 'visible_response' },
    };
  }

  return {
    message: statusText(locale, 'finalOutput'),
    phase: 'returning_model_output',
    details: { ...common, response_disposition: 'model_output' },
  };
}

function describeStreamingAnthropicProgress(payload, { locale = 'zh-TW' } = {}) {
  const block = payload?.content_block;
  const type = String(block?.type || '');
  const toolName = type === 'tool_use' ? safeToolName(block?.name) : '';
  const common = {
    terminal_for_proxy: false,
    terminal_for_claude_task: false,
    tool_names: toolName ? [toolName] : [],
  };

  if (type === 'tool_use') {
    return {
      message: statusText(locale, 'streamingTool'),
      phase: 'streaming_tool_action',
      details: { ...common, response_disposition: 'tool_handoff' },
    };
  }
  if (type === 'text') {
    return {
      message: statusText(locale, 'streamingVisible'),
      phase: 'streaming_visible_response',
      details: { ...common, response_disposition: 'visible_response' },
    };
  }
  if (type === 'thinking') {
    return {
      message: statusText(locale, 'streamingThinking'),
      phase: 'streaming_thinking',
      details: { ...common, response_disposition: 'thinking' },
    };
  }
  return {
    message: statusText(locale, 'streamingOutput'),
    phase: 'streaming_model_output',
    details: { ...common, response_disposition: 'model_output' },
  };
}

async function emitTextBlock(progress, index, block) {
  await progress.writeRaw(formatSseEvent('content_block_start', {
    type: 'content_block_start', index, content_block: { type: 'text', text: '' },
  }));
  if (block.text) {
    await progress.writeRaw(formatSseEvent('content_block_delta', {
      type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text },
    }));
  }
  await progress.writeRaw(formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}

async function emitThinkingBlock(progress, index, block) {
  await progress.writeRaw(formatSseEvent('content_block_start', {
    type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: block.signature || '' },
  }));
  if (block.thinking) {
    await progress.writeRaw(formatSseEvent('content_block_delta', {
      type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking },
    }));
  }
  await progress.writeRaw(formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}

async function emitToolUseBlock(progress, index, block) {
  await progress.writeRaw(formatSseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
  }));
  const input = JSON.stringify(block.input ?? {});
  await progress.writeRaw(formatSseEvent('content_block_delta', {
    type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input },
  }));
  await progress.writeRaw(formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}


async function emitServerToolUseBlock(progress, index, block) {
  await progress.writeRaw(formatSseEvent('content_block_start', {
    type: 'content_block_start', index,
    content_block: { type: 'server_tool_use', id: block.id, name: block.name, input: {} },
  }));
  const input = JSON.stringify(block.input ?? {});
  await progress.writeRaw(formatSseEvent('content_block_delta', {
    type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input },
  }));
  await progress.writeRaw(formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}

async function emitServerResultBlock(progress, index, block) {
  await progress.writeRaw(formatSseEvent('content_block_start', {
    type: 'content_block_start', index, content_block: block,
  }));
  await progress.writeRaw(formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}

export function createServerToolStreamBridge(progress) {
  let nextIndex = null;
  const ensureStarted = async () => {
    if (nextIndex !== null) return;
    await progress.closeProgress();
    nextIndex = progress.visible ? 1 : 0;
  };
  return {
    get nextIndex() {
      return nextIndex === null ? (progress.visible ? 1 : 0) : nextIndex;
    },
    async emit(event) {
      if (!event?.block) return;
      await ensureStarted();
      if (event.phase === 'use' && event.block.type === 'server_tool_use') {
        await emitServerToolUseBlock(progress, nextIndex, event.block);
      } else if (event.phase === 'result' && ['web_search_tool_result', 'web_fetch_tool_result'].includes(event.block.type)) {
        await emitServerResultBlock(progress, nextIndex, event.block);
      } else {
        return;
      }
      nextIndex += 1;
    },
  };
}

export async function emitFinalAnthropicResponse(progress, response, { startIndex, locale = 'zh-TW' } = {}) {
  const finalProgress = describeFinalAnthropicProgress(response, { locale });
  await progress.closeProgress(finalProgress.message, {
    phase: finalProgress.phase,
    details: finalProgress.details,
  });
  let index = Number.isInteger(startIndex) ? startIndex : (progress.visible ? 1 : 0);
  for (const block of response.content || []) {
    if (block.type === 'text') await emitTextBlock(progress, index, block);
    else if (block.type === 'thinking') await emitThinkingBlock(progress, index, block);
    else if (block.type === 'tool_use') await emitToolUseBlock(progress, index, block);
    else if (block.type === 'server_tool_use') await emitServerToolUseBlock(progress, index, block);
    else if (['web_search_tool_result', 'web_fetch_tool_result'].includes(block.type)) await emitServerResultBlock(progress, index, block);
    else {
      await progress.writeRaw(formatSseEvent('content_block_start', {
        type: 'content_block_start', index, content_block: block,
      }));
      await progress.writeRaw(formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
    }
    index += 1;
  }
  await progress.writeRaw(formatSseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: response.stop_reason ?? 'end_turn',
      stop_sequence: response.stop_sequence ?? null,
    },
    usage: usageForProgress(progress, response.usage || {}),
  }));
  progress.stopKeepalive();
  await progress.writeRaw(formatSseEvent('message_stop', { type: 'message_stop' }));
  await progress.stop();
  progress.res.end();
}

export async function emitSseError(progress, error) {
  try {
    await progress.closeProgress();
    progress.stopKeepalive();
    await progress.writeRaw(formatSseEvent('error', {
      type: 'error',
      error: {
        type: error.code || 'internal_error',
        message: error.message || 'Internal proxy error.',
        retryable: Boolean(error.retryable),
      },
    }));
    await progress.stop();
    progress.res.end();
  } finally {
    await progress.stop();
  }
}

function parseSseBlock(block) {
  let name = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { name, data: data.join('\n') };
}

function shiftEventIndex(payload, offset) {
  if (!offset || !payload || typeof payload !== 'object') return payload;
  if (['content_block_start', 'content_block_delta', 'content_block_stop'].includes(payload.type)
      && Number.isInteger(payload.index)) {
    return { ...payload, index: payload.index + offset };
  }
  return payload;
}

export async function pipeAnthropicUpstreamStream(progress, upstream, {
  onDiagnostic = () => {}, onFirstEvent = () => {}, onComplete = () => {}, onUsage = () => {}, locale = 'zh-TW',
} = {}) {
  let offset = 0;
  let progressClosedForModel = false;
  let firstModelEventObserved = false;
  if (!upstream.body) {
    progress.stopSemanticHeartbeat?.();
    await progress.closeProgress();
    progress.stopKeepalive();
    await progress.stop();
    await onComplete();
    progress.res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let diagnosticTail = '';
  let diagnosticTagCount = 0;
  const diagnosticTags = new Set();
  const diagnosticChannels = new Set();
  const observeControlTags = (value, channel) => {
    const current = String(value || '');
    if (!current) return;
    const combined = diagnosticTail + current;
    for (const match of findControlTags(combined)) {
      const end = match.index + match.raw.length;
      if (end <= diagnosticTail.length) continue;
      diagnosticTagCount += 1;
      diagnosticTags.add(match.name);
      diagnosticChannels.add(channel);
    }
    diagnosticTail = combined.slice(-256);
  };
  const closeProgressForModel = async (payload = null) => {
    if (progressClosedForModel) return;
    progress.stopSemanticHeartbeat?.();
    const state = describeStreamingAnthropicProgress(payload, { locale });
    await progress.closeProgress(state.message, { phase: state.phase, details: state.details });
    progressClosedForModel = true;
    offset = progress.visible ? 1 : 0;
  };
  const processBlock = async (block) => {
    if (!block.trim()) return;
    const parsed = parseSseBlock(block);
    let data = parsed.data;
    let payload = null;
    if (data) {
      try { payload = JSON.parse(data); } catch {}
    }
    if (parsed.name === 'message_start') {
      try {
        await onUsage({
          stage: 'message_start',
          usage: normalizeAnthropicUsage(payload?.message?.usage),
        });
      } catch {}
      return;
    }
    if (parsed.name === 'message_delta' && payload?.usage) {
      try {
        await onUsage({
          stage: 'message_delta',
          usage: normalizeAnthropicUsage(payload.usage),
        });
      } catch {}
    }
    const meaningful = parsed.name === 'content_block_start' || parsed.name === 'content_block_delta';
    if (meaningful && !firstModelEventObserved) {
      firstModelEventObserved = true;
      await closeProgressForModel(payload);
      await onFirstEvent({ event: parsed.name, type: payload?.type || '', block_type: payload?.content_block?.type || '' });
    }
    if (parsed.name === 'message_stop' && !progressClosedForModel) await closeProgressForModel();
    if (parsed.name === 'message_stop') progress.stopKeepalive();

    if (parsed.name === 'message_delta' && payload) {
      payload = { ...payload, usage: usageForProgress(progress, payload.usage || {}) };
    }

    if (payload) {
      if (payload?.type === 'content_block_delta') {
        if (payload.delta?.type === 'thinking_delta') observeControlTags(payload.delta.thinking, 'thinking');
        if (payload.delta?.type === 'text_delta') observeControlTags(payload.delta.text, 'text');
      }
      data = JSON.stringify(shiftEventIndex(payload, offset));
    }
    await progress.writeRaw(`${parsed.name ? `event: ${parsed.name}\n` : ''}${data ? `data: ${data}\n` : ''}\n`, {
      kind: 'upstream_event', upstreamEvent: parsed.name,
    });
  };

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      await processBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await processBlock(buffer);
  if (!progressClosedForModel) await closeProgressForModel();
  if (diagnosticTagCount > 0) {
    await onDiagnostic('base_generation_control_tags_detected', {
      tagCount: diagnosticTagCount,
      tags: [...diagnosticTags],
      channels: [...diagnosticChannels],
    });
  }
  progress.stopKeepalive();
  await progress.stop();
  await onComplete({ firstModelEventObserved });
  progress.res.end();
}
