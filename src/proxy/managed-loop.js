import { statusText } from '../i18n/response-language.js';
import { HttpError } from '../lib/http.js';
import {
  buildManagedContinuationRecoveryRequest,
  buildManagedEmptyEndTurnRecoveryRequest,
  buildManagedFinalChannelRecoveryRequest,
  classifyManagedRecovery,
  inspectManagedFinalResponse,
  promoteManagedFinalAnswer,
} from './managed-final.js';
import { inventoryProtocolTags, neutralizeProtocolValue } from './protocol-sanitizer.js';
import { isManagedToolName, normalizeManagedToolName, normalizeManagedToolUseBlock } from './web-tools.js';
import {
  normalizeNativeWebToolResponse,
  canonicalWebToolName,
  createServerWebToolUse,
  createServerWebToolResult,
  sanitizeCompletedServerWebHistory,
} from './native-web-tools.js';
import { injectManagedWebResultInstruction, renderManagedToolResult } from './web-result-contract.js';
import { collectRequestProtocolSnippets, collectResponseAnomalySnippets } from './protocol-diagnostics.js';
import { prepareContinuationState } from './continuation-state.js';
import {
  isToolSearchToolName,
  executeLocalToolSearch,
  materializeLocalToolSearchTools,
  createLocalToolSearchResult,
  localToolSearchStateSnapshot,
} from './tool-search.js';


const DEFAULT_MANAGED_TASK_TIMEOUT_MS = 0;
const DEFAULT_MODEL_ROUND_TIMEOUT_MS = 360_000;
const DEFAULT_MODEL_STALL_TIMEOUT_MS = 90_000;
const DEFAULT_TOOL_STALL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_STALL_RECOVERY_ROUNDS = 2;
const DEFAULT_MAX_COMPLETION_PROBES_PER_CANDIDATE = 999;
const COMPLETION_PROBE_PROMPT = 'Review the original request and your latest response. If required work remains, continue executing it now using tools. Do not restate the plan or repeat completed work. If fully complete, return normally without tool use.';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}



function completionCandidateKey(response) {
  return JSON.stringify({
    stop_reason: response?.stop_reason ?? null,
    content: stableValue(Array.isArray(response?.content) ? response.content : []),
  });
}

function buildCompletionProbeRequest(request, candidateFinal) {
  const probe = structuredClone(request);
  probe.messages = Array.isArray(probe.messages) ? probe.messages : [];
  probe.messages.push({
    role: 'assistant',
    content: structuredClone(Array.isArray(candidateFinal?.content) ? candidateFinal.content : []),
  });
  probe.messages.push({
    role: 'user',
    content: [{ type: 'text', text: COMPLETION_PROBE_PROMPT }],
  });
  return probe;
}

function normalizedToolUses(response) {
  if (!Array.isArray(response?.content)) return [];
  return response.content
    .map((block) => normalizeManagedToolUseBlock(block))
    .filter((block) => block?.type === 'tool_use');
}

function candidateTelemetry(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  let textBytes = 0;
  let thinkingBytes = 0;
  for (const block of content) {
    if (block?.type === 'text') textBytes += Buffer.byteLength(String(block.text || ''));
    if (block?.type === 'thinking') thinkingBytes += Buffer.byteLength(String(block.thinking || ''));
  }
  return { text_bytes: textBytes, thinking_bytes: thinkingBytes };
}

function managedActionSignature(toolUses) {
  return JSON.stringify(toolUses.map((toolUse) => ({
    name: normalizeManagedToolName(toolUse?.name),
    input: stableValue(toolUse?.input ?? {}),
  })));
}


function recoveryBlockKey(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'tool_use') {
    if (block.id) return `tool-id:${block.id}`;
    return `tool:${String(block.name || '')}:${JSON.stringify(stableValue(block.input ?? {}))}`;
  }
  if (block.type === 'text') return `text:${String(block.text || '')}`;
  return '';
}

function recoverableCheckpointBlocks(checkpoint) {
  const blocks = Array.isArray(checkpoint?.completed_blocks) ? checkpoint.completed_blocks : [];
  const seen = new Set();
  const safe = [];
  for (const raw of blocks) {
    if (!raw || !['text', 'tool_use'].includes(raw.type)) continue;
    if (raw.type === 'text' && !String(raw.text || '').trim()) continue;
    if (raw.type === 'tool_use' && (!raw.name || !raw.input || typeof raw.input !== 'object')) continue;
    const block = structuredClone(raw);
    const key = recoveryBlockKey(block);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    safe.push(block);
  }
  return safe;
}

function mergeRecoveryBlocks(existing = [], additions = []) {
  const merged = [];
  const seen = new Set();
  for (const raw of [...existing, ...additions]) {
    const key = recoveryBlockKey(raw);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(structuredClone(raw));
  }
  return merged;
}

function recoveryCheckpointSummary(blocks, checkpoint, attempt, maxAttempts) {
  const lines = blocks.map((block, index) => {
    if (block.type === 'tool_use') {
      const input = JSON.stringify(block.input ?? {});
      return `${index + 1}. tool_use ${block.name} ${input.slice(0, 1200)}`;
    }
    const text = String(block.text || '');
    const tail = text.length > 4000 ? text.slice(-4000) : text;
    return `${index + 1}. text ${JSON.stringify(tail)}`;
  });
  const partial = checkpoint?.partial_block || null;
  return [
    '[PROXY_MANAGED_RESPONSE_RECOVERY]',
    `Recovery attempt ${attempt}/${maxAttempts}.`,
    `Previous stream phase: ${String(checkpoint?.phase || 'unknown')}.`,
    'The prior assistant stream stalled before message completion. The proxy preserved only blocks that reached a complete semantic boundary.',
    'Continue the same task from this checkpoint. Do not restart the task and do not repeat any preserved text or completed tool call.',
    partial ? `The interrupted partial block was ${String(partial.type || 'unknown')}${partial.name ? ` ${partial.name}` : ''}; regenerate that unfinished block from its beginning if it is still needed.` : 'No partial block metadata was available.',
    lines.length ? 'Preserved completed blocks:\n' + lines.join('\n') : 'No completed non-thinking blocks were preserved; reconstruct only the missing continuation.',
    'Return only the remaining assistant continuation using normal Anthropic content/tool semantics.',
  ].join('\n');
}

function classifyManagedToolInputFailure(error) {
  if (!(error instanceof HttpError)) return null;
  if (error.code === 'vllm_tool_input_loop_detected') return 'loop_detected';
  if (error.code !== 'vllm_invalid_stream') return null;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  const partialBytes = Number(details.partial_json_bytes);
  const outputTokens = Number(details.output_tokens);
  const maxTokens = Number(details.max_tokens);
  if (!String(details.tool_name || '') || !(partialBytes > 0) || !(maxTokens > 0) || !(outputTokens >= maxTokens)) return null;
  return 'max_tokens_truncation';
}


function classifyManagedStreamLoopFailure(error) {
  if (!(error instanceof HttpError)) return null;
  if (error.code === 'vllm_thinking_loop_detected') return 'thinking';
  if (error.code === 'vllm_response_loop_detected') return 'response';
  return null;
}

function streamLoopRecoverySummary(blocks, checkpoint, kind) {
  const lines = blocks.map((block, index) => {
    if (block.type === 'tool_use') {
      const input = JSON.stringify(block.input ?? {});
      return `${index + 1}. tool_use ${block.name} ${input.slice(0, 1200)}`;
    }
    const text = String(block.text || '');
    const tail = text.length > 4000 ? text.slice(-4000) : text;
    return `${index + 1}. text ${JSON.stringify(tail)}`;
  });
  const partial = checkpoint?.partial_block || null;
  const cause = kind === 'thinking'
    ? 'The previous reasoning stream entered a repetitive loop.'
    : 'The previous visible response entered a repetitive loop.';
  const continuation = kind === 'thinking'
    ? 'Continue the same task from the completed checkpoint without repeating the prior reasoning.'
    : 'Regenerate only the remaining answer or remaining continuation from the completed checkpoint, concisely and without repeating prior text.';
  return [
    '[PROXY_MANAGED_STREAM_LOOP_RECOVERY]',
    cause,
    'The unfinished looping block was discarded in full and must not be continued from its partial text.',
    continuation,
    'Do not repeat preserved completed actions or preserved completed text.',
    partial ? `The discarded partial block was ${String(partial.type || 'unknown')}; regenerate it from its beginning only if it is still required.` : 'No partial block metadata was available.',
    lines.length ? 'Preserved completed blocks:\n' + lines.join('\n') : 'No completed non-thinking blocks were preserved.',
    'Return only the remaining assistant continuation using normal Anthropic content/tool semantics.',
  ].join('\n');
}

function buildManagedStreamLoopRecoveryRequest(originalRequest, blocks, checkpoint, kind) {
  const recovered = structuredClone(originalRequest);
  recovered.messages = Array.isArray(recovered.messages) ? recovered.messages : [];
  recovered.messages.push({
    role: 'user',
    content: [{ type: 'text', text: streamLoopRecoverySummary(blocks, checkpoint, kind) }],
  });
  return recovered;
}

function exhaustedStreamLoopRecoveryError(kind, error) {
  return new HttpError(502, `Base model repeated a ${kind} generation loop after one bounded recovery attempt.`, {
    code: kind === 'thinking'
      ? 'managed_thinking_loop_recovery_exhausted'
      : 'managed_response_loop_recovery_exhausted',
    retryable: false,
    details: {
      ...(error?.details && typeof error.details === 'object' ? structuredClone(error.details) : {}),
      stream_kind: kind,
      upstream_code: String(error?.code || ''),
    },
  });
}

function toolInputRecoverySummary(blocks, checkpoint, reason) {
  const lines = blocks.map((block, index) => {
    if (block.type === 'tool_use') {
      const input = JSON.stringify(block.input ?? {});
      return `${index + 1}. tool_use ${block.name} ${input.slice(0, 1200)}`;
    }
    const text = String(block.text || '');
    const tail = text.length > 4000 ? text.slice(-4000) : text;
    return `${index + 1}. text ${JSON.stringify(tail)}`;
  });
  const partial = checkpoint?.partial_block || null;
  const cause = reason === 'loop_detected'
    ? 'The previous tool input entered a repetitive generation loop.'
    : 'The previous tool input reached the output token limit before its JSON arguments completed.';
  return [
    '[PROXY_MANAGED_TOOL_INPUT_RECOVERY]',
    cause,
    'The unfinished tool call was discarded in full and must never be continued from partial JSON.',
    'Continue the same task from the completed checkpoint. Do not repeat preserved completed actions.',
    partial ? `The discarded partial block was ${String(partial.type || 'unknown')}${partial.name ? ` ${partial.name}` : ''}; regenerate that unfinished tool call from its beginning only if it is still needed.` : 'No partial block metadata was available.',
    'If the tool action is still required, regenerate it with concise arguments and avoid repeated large enumerations or duplicated data.',
    lines.length ? 'Preserved completed blocks:\n' + lines.join('\n') : 'No completed non-thinking blocks were preserved.',
    'Return only the remaining assistant continuation using normal Anthropic content/tool semantics.',
  ].join('\n');
}

function buildManagedToolInputRecoveryRequest(originalRequest, blocks, checkpoint, reason) {
  const recovered = structuredClone(originalRequest);
  recovered.messages = Array.isArray(recovered.messages) ? recovered.messages : [];
  recovered.messages.push({
    role: 'user',
    content: [{ type: 'text', text: toolInputRecoverySummary(blocks, checkpoint, reason) }],
  });
  return recovered;
}

function exhaustedToolInputRecoveryError(reason, error) {
  return new HttpError(502, 'Base model repeated an invalid tool input after one bounded recovery attempt.', {
    code: reason === 'loop_detected'
      ? 'managed_tool_loop_recovery_exhausted'
      : 'managed_tool_truncation_recovery_exhausted',
    retryable: false,
    details: {
      ...(error?.details && typeof error.details === 'object' ? structuredClone(error.details) : {}),
      recovery_reason: reason,
      upstream_code: String(error?.code || ''),
      tool_name: String(error?.details?.tool_name || ''),
      partial_json_bytes: Number(error?.details?.partial_json_bytes || 0),
    },
  });
}

function buildManagedStallRecoveryRequest(originalRequest, blocks, checkpoint, attempt, maxAttempts) {
  const recovered = structuredClone(originalRequest);
  recovered.messages = Array.isArray(recovered.messages) ? recovered.messages : [];
  recovered.messages.push({
    role: 'user',
    content: [{ type: 'text', text: recoveryCheckpointSummary(blocks, checkpoint, attempt, maxAttempts) }],
  });
  return recovered;
}

function mergeManagedStallRecoveryResponse(blocks, response) {
  if (!blocks.length) return response;
  const seen = new Set(blocks.map(recoveryBlockKey).filter(Boolean));
  const continuation = [];
  for (const raw of Array.isArray(response?.content) ? response.content : []) {
    if (!raw || raw.type === 'thinking') continue;
    const key = recoveryBlockKey(raw);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    continuation.push(structuredClone(raw));
  }
  const content = [...blocks.map((block) => structuredClone(block)), ...continuation];
  const hasToolUse = content.some((block) => block?.type === 'tool_use');
  return {
    ...response,
    content,
    stop_reason: hasToolUse && !continuation.length ? 'tool_use' : response?.stop_reason,
  };
}

function managedTimeoutError(code, timeoutMs, phase, extraDetails = {}) {
  const message = code === 'managed_task_timeout'
    ? 'Managed task exceeded its total execution deadline.'
    : code === 'managed_model_stall_timeout'
      ? 'Base model response stalled after upstream response bytes began arriving.'
      : 'Base model did not complete the managed round within the bounded model deadline.';
  return new HttpError(504, message, {
    code,
    retryable: true,
    details: { timeout_ms: timeoutMs, phase, ...extraDetails },
  });
}

async function runWithBoundedTime(operation, {
  signal,
  timeoutMs,
  timeoutCode,
  phase,
}) {
  if (signal?.aborted) throw signal.reason || new Error('Aborted');
  const controller = new AbortController();
  let parentAbort;
  let timer;
  const timeoutError = managedTimeoutError(timeoutCode, timeoutMs, phase);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const parentAbortPromise = new Promise((_, reject) => {
    if (!signal) return;
    parentAbort = () => {
      const reason = signal.reason || new Error('Aborted');
      controller.abort(reason);
      reject(reason);
    };
    signal.addEventListener('abort', parentAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeoutPromise,
      parentAbortPromise,
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && parentAbort) signal.removeEventListener('abort', parentAbort);
  }
}


async function runModelWithActivityDeadline(operation, {
  signal,
  timeoutMs,
  timeoutCode = 'managed_model_timeout',
  stallTimeoutMs = DEFAULT_MODEL_STALL_TIMEOUT_MS,
  toolStallTimeoutMs = stallTimeoutMs > 0 ? Math.max(DEFAULT_TOOL_STALL_TIMEOUT_MS, stallTimeoutMs * 3) : 0,
  responseMode = 'auto',
  getUpstreamActivity = null,
  onRoundState = () => {},
  round = 0,
}) {
  if (signal?.aborted) throw signal.reason || new Error('Aborted');
  const startedAt = Date.now();
  const initialActivity = typeof getUpstreamActivity === 'function' ? (getUpstreamActivity() || {}) : {};
  const startBytes = Number(initialActivity.receivedBytes) || 0;
  const controller = new AbortController();
  let parentAbort;
  let hardTimer;
  let stallTimer;
  let settled = false;
  let rejectStall;
  const configuredResponseMode = ['streaming', 'buffered'].includes(responseMode) ? responseMode : 'auto';
  const currentRoundActivity = () => {
    const activity = typeof getUpstreamActivity === 'function' ? (getUpstreamActivity() || {}) : {};
    const bytes = Number(activity.receivedBytes) || startBytes;
    const lastByteAt = Number(activity.lastByteAt) || 0;
    const observedResponseMode = ['streaming', 'buffered'].includes(activity.responseMode) ? activity.responseMode : '';
    const phase = ['waiting', 'thinking', 'response', 'tool'].includes(activity.phase) ? activity.phase : 'waiting';
    return {
      started: bytes > startBytes && lastByteAt >= startedAt,
      bytes,
      lastByteAt,
      phase,
      responseMode: configuredResponseMode === 'auto' ? (observedResponseMode || (bytes > startBytes ? 'streaming' : 'auto')) : configuredResponseMode,
    };
  };
  let rejectHard;
  const hardPromise = new Promise((_, reject) => { rejectHard = reject; });
  const armHardDeadline = (delayMs) => {
    hardTimer = setTimeout(() => {
      // Streaming responses use this as a first-byte deadline and then switch
      // to inactivity protection. Buffered responses keep this as an absolute
      // model-round completion deadline because silence after initial bytes is
      // expected and does not prove the model has stalled.
      const roundActivity = currentRoundActivity();
      if (roundActivity.started && roundActivity.responseMode === 'streaming') return;
      const rawActivity = typeof getUpstreamActivity === 'function' ? (getUpstreamActivity() || {}) : {};
      if (rawActivity.busyWaiting) {
        armHardDeadline(Math.max(5, Math.min(1000, timeoutMs)));
        return;
      }
      const acceptedAt = Number(rawActivity.busyAcceptedAt) || 0;
      const deadlineBase = acceptedAt > startedAt ? acceptedAt : startedAt;
      const remainingMs = timeoutMs - (Date.now() - deadlineBase);
      if (remainingMs > 0) {
        armHardDeadline(remainingMs);
        return;
      }
      const activity = currentRoundActivity();
      const error = managedTimeoutError(timeoutCode, timeoutMs, 'model', {
        response_mode: activity.responseMode,
        received_bytes: activity.bytes,
        idle_ms: activity.lastByteAt > 0 ? Math.max(0, Date.now() - activity.lastByteAt) : 0,
      });
      controller.abort(error);
      rejectHard(error);
    }, Math.max(1, delayMs));
  };
  armHardDeadline(timeoutMs);
  const parentAbortPromise = new Promise((_, reject) => {
    if (!signal) return;
    parentAbort = () => {
      const reason = signal.reason || new Error('Aborted');
      controller.abort(reason);
      reject(reason);
    };
    signal.addEventListener('abort', parentAbort, { once: true });
  });
  const stallPromise = new Promise((_, reject) => { rejectStall = reject; });
  const smallestStallBudget = Math.max(1, Math.min(
    stallTimeoutMs > 0 ? stallTimeoutMs : Number.POSITIVE_INFINITY,
    toolStallTimeoutMs > 0 ? toolStallTimeoutMs : Number.POSITIVE_INFINITY,
  ));
  const pollMs = Math.max(5, Math.min(1000, Math.floor(smallestStallBudget / 4) || 5));
  if (typeof getUpstreamActivity === 'function' && stallTimeoutMs > 0) {
    stallTimer = setInterval(() => {
      if (settled) return;
      const activity = currentRoundActivity();
      if (activity.responseMode !== 'streaming') return;
      const effectiveStallTimeoutMs = activity.phase === 'tool' && toolStallTimeoutMs > 0
        ? toolStallTimeoutMs
        : stallTimeoutMs;
      const idleMs = activity.lastByteAt > 0 ? Math.max(0, Date.now() - activity.lastByteAt) : 0;
      if (!activity.started || idleMs < effectiveStallTimeoutMs) return;
      const error = managedTimeoutError('managed_model_stall_timeout', effectiveStallTimeoutMs, activity.phase || 'model', {
        response_mode: activity.responseMode,
        received_bytes: activity.bytes,
        idle_ms: idleMs,
        stream_phase: activity.phase || 'waiting',
        base_stall_timeout_ms: stallTimeoutMs,
        tool_stall_timeout_ms: toolStallTimeoutMs,
      });
      controller.abort(error);
      rejectStall(error);
    }, pollMs);
    stallTimer.unref?.();
  }

  await onRoundState({ phase: 'start', round, startedAt, startBytes });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      hardPromise,
      parentAbortPromise,
      stallPromise,
    ]);
  } finally {
    settled = true;
    clearTimeout(hardTimer);
    if (stallTimer) clearInterval(stallTimer);
    if (signal && parentAbort) signal.removeEventListener('abort', parentAbort);
    await onRoundState({ phase: 'end', round, startedAt, endedAt: Date.now() });
  }
}

function progressMessage(name, input, phase, locale = 'zh-TW') {
  const normalized = normalizeManagedToolName(name);
  if (normalized === 'WebSearch') {
    const query = String(input?.query ?? input?.q ?? '').slice(0, 160);
    return phase === 'start' ? statusText(locale, 'searchStart', { query }) : statusText(locale, 'searchDone', { query });
  }
  if (normalized === 'WebFetch') {
    let host = '';
    try { host = new URL(input?.url).host; } catch {}
    if (phase === 'start') return statusText(locale, 'fetchStart', { host });
    if (phase === 'error') return statusText(locale, 'fetchError', { host });
    return statusText(locale, 'fetchDone', { host });
  }
  return statusText(locale, 'genericProcessing');
}

function safeToolError(error) {
  const details = {};
  if (Number.isInteger(error?.details?.upstream_status)) details.upstream_status = error.details.upstream_status;
  if (typeof error?.details?.upstream_code === 'string') details.upstream_code = error.details.upstream_code.slice(0, 200);
  return {
    error: {
      code: typeof error?.code === 'string' ? error.code : 'managed_tool_error',
      message: typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'Managed tool failed.',
      retryable: Boolean(error?.retryable),
      ...(Object.keys(details).length ? { details } : {}),
    },
  };
}

async function inspectFinal(response, { onDiagnostic, round, repair }) {
  const inspection = inspectManagedFinalResponse(response);
  await onDiagnostic('managed_final_response_inspected', {
    round,
    repair,
    ...inspection,
  });
  if (!inspection.valid && inspection.reasons.some((reason) => [
    'control_tag_leak', 'final_answer_in_thinking',
  ].includes(reason))) {
    await onDiagnostic('laguna_runtime_contract_violation', {
      round,
      repair,
      expected_tool_parser: 'poolside_v1',
      expected_reasoning_parser: 'poolside_v1',
      reasons: inspection.reasons,
      control_tag_count: inspection.control_tag_count,
      control_tag_counts: inspection.control_tag_counts,
      thinking_only: inspection.reasons.includes('final_answer_in_thinking'),
    });
  }
  return inspection;
}

async function emitDetailedFinalDiagnostics(request, response, inspection, {
  onDiagnostic, writeProtocolDiagnostics, round, repair, includeInput,
}) {
  const outputSnippets = collectResponseAnomalySnippets(
    response,
    inspection,
    { includeFullText: true },
  );
  const inputSnippets = includeInput
    ? collectRequestProtocolSnippets(request, { includeFullText: true })
    : [];
  const bundle = {
    round,
    repair,
    reasons: inspection.reasons,
    response: {
      id: typeof response?.id === 'string' ? response.id : null,
      model: typeof response?.model === 'string' ? response.model : null,
      stop_reason: response?.stop_reason ?? null,
      block_types: Array.isArray(response?.content)
        ? response.content.map((block) => String(block?.type || 'unknown'))
        : [],
    },
    output_snippets: outputSnippets,
    input_snippets: inputSnippets,
  };

  if (typeof writeProtocolDiagnostics !== 'function') {
    await onDiagnostic('managed_final_response_diagnostic_file_failed', {
      round,
      repair,
      reasons: inspection.reasons,
      code: 'DIAGNOSTIC_WRITER_UNAVAILABLE',
      output_snippet_count: outputSnippets.length,
      input_snippet_count: inputSnippets.length,
    });
    return;
  }

  try {
    const file = await writeProtocolDiagnostics(bundle);
    await onDiagnostic('managed_final_response_diagnostic_file', {
      round,
      repair,
      reasons: inspection.reasons,
      output_snippet_count: outputSnippets.length,
      input_snippet_count: inputSnippets.length,
      ...file,
    });
  } catch (error) {
    await onDiagnostic('managed_final_response_diagnostic_file_failed', {
      round,
      repair,
      reasons: inspection.reasons,
      code: typeof error?.code === 'string' ? error.code : 'DIAGNOSTIC_WRITE_FAILED',
      output_snippet_count: outputSnippets.length,
      input_snippet_count: inputSnippets.length,
    });
  }
}


function requestReasoningEffort(request) {
  const direct = request?.output_config?.effort ?? request?.reasoning_effort ?? request?.effort;
  return typeof direct === 'string' && direct.trim() ? direct.trim() : 'unspecified';
}

function countImageBlocks(value) {
  let count = 0;
  const walk = (item) => {
    if (Array.isArray(item)) { for (const entry of item) walk(entry); return; }
    if (!item || typeof item !== 'object') return;
    if (item.type === 'image' && item.source && typeof item.source === 'object') count += 1;
    for (const entry of Object.values(item)) walk(entry);
  };
  walk(value);
  return count;
}

async function recoverInvalidResponse(request, response, {
  upstream, signal, onDiagnostic, onProgress, round, logProtocolSnippets,
  writeProtocolDiagnostics, locale = 'zh-TW', compressContinuationWindow,
}) {
  const inspection = await inspectFinal(response, { onDiagnostic, round, repair: false });
  if (inspection.valid) return { response, recovered: false, recovery: null };

  if (logProtocolSnippets) {
    await emitDetailedFinalDiagnostics(request, response, inspection, {
      onDiagnostic, writeProtocolDiagnostics, round, repair: false, includeInput: true,
    });
  }

  const promotion = promoteManagedFinalAnswer(response, inspection);
  if (promotion) {
    await onDiagnostic('managed_final_response_promoted', {
      round,
      route: promotion.route,
      source: promotion.source,
      text_bytes: Buffer.byteLength(promotion.response.content[0].text),
      recovery_signals: promotion.signals,
    });
    return {
      response: promotion.response,
      recovered: true,
      recovery: { route: promotion.route, tools_preserved: false, promoted: true },
    };
  }

  const recovery = classifyManagedRecovery(response, inspection);
  if (recovery.route === 'regeneration') {
    const totalImages = countImageBlocks(request?.messages || []);
    const currentTurnImages = countImageBlocks(Array.isArray(request?.messages) ? request.messages.at(-1) : null);
    const diagnosticBase = {
      round,
      stop_reason: inspection.stop_reason,
      requested_effort: requestReasoningEffort(request),
      message_count: Array.isArray(request?.messages) ? request.messages.length : 0,
      image_count_total: totalImages,
      image_count_current_turn: currentTurnImages,
      max_tokens: Number.isFinite(Number(request?.max_tokens)) ? Number(request.max_tokens) : null,
      temperature: Number.isFinite(Number(request?.temperature)) ? Number(request.temperature) : null,
      top_p: Number.isFinite(Number(request?.top_p)) ? Number(request.top_p) : null,
      top_k: Number.isFinite(Number(request?.top_k)) ? Number(request.top_k) : null,
    };
    await onDiagnostic('managed_empty_end_turn_regeneration_started', diagnosticBase);
    await onProgress(statusText(locale, 'emptyEndTurnRegeneration'), {
      phase: 'managed_empty_end_turn_regeneration_start',
      round,
      recovery_route: 'regeneration',
      force: true,
    });
    const recoveryRequest = buildManagedEmptyEndTurnRecoveryRequest(request);
    const recoveredResponse = await upstream(recoveryRequest, signal);
    const recoveredInspection = await inspectFinal(recoveredResponse, {
      onDiagnostic, round, repair: true,
    });
    if (recoveredInspection.valid) {
      await onDiagnostic('managed_empty_end_turn_regeneration_success', {
        ...diagnosticBase,
        text_bytes: recoveredInspection.text_bytes,
        thinking_bytes: recoveredInspection.thinking_bytes,
        tool_use_count: recoveredInspection.tool_use_count,
      });
      return {
        response: recoveredResponse,
        recovered: true,
        recovery: { route: 'regeneration', tools_preserved: true },
      };
    }
    if (recoveredInspection.reasons.includes('upstream_empty_end_turn')) {
      await onDiagnostic('managed_empty_end_turn_regeneration_exhausted', diagnosticBase);
      throw new HttpError(502, 'Base model returned an empty end_turn twice.', {
        code: 'empty_end_turn_recovery_exhausted',
        retryable: true,
        details: { recovery_route: 'regeneration' },
      });
    }
    await onDiagnostic('managed_final_response_rejected', {
      round,
      recovery_route: 'regeneration',
      tools_preserved: true,
      reasons: recoveredInspection.reasons,
      control_tag_count: recoveredInspection.control_tag_count,
      control_tag_counts: recoveredInspection.control_tag_counts,
    });
    throw new HttpError(502, 'Base model did not produce a valid next action after empty-response regeneration.', {
      code: 'response_recovery_exhausted',
      retryable: true,
      details: { recovery_route: 'regeneration' },
    });
  }
  await onDiagnostic('managed_final_response_repair_start', {
    round,
    reasons: inspection.reasons,
    control_tag_count: inspection.control_tag_count,
    control_tag_counts: inspection.control_tag_counts,
    recovery_route: recovery.route,
    tools_preserved: recovery.tools_preserved,
    recovery_signals: recovery.signals,
  });
  await onProgress(
    recovery.route === 'final_channel'
      ? statusText(locale, 'finalChannelRecovery')
      : statusText(locale, 'continuationRecovery', { candidateChars: recovery.signals.candidate_chars }),
    {
      phase: recovery.route === 'final_channel'
        ? 'managed_final_channel_recovery_start'
        : 'managed_continuation_recovery_start',
      round,
      recovery_route: recovery.route,
      force: true,
    },
  );

  let preparedState = null;
  if (recovery.route === 'continuation') {
    preparedState = await prepareContinuationState(response, {
      compressWindow: compressContinuationWindow,
      signal,
      onEvent: onDiagnostic,
    });
    await onProgress(statusText(locale, 'continuationStatePreserved', {
      candidateChars: preparedState.candidateChars,
      handoffChars: preparedState.handoffChars,
      compressed: preparedState.compressed,
    }), {
      phase: 'managed_continuation_state_preserved',
      round,
      recovery_route: recovery.route,
      continuation_mode: preparedState.mode,
      candidate_chars: preparedState.candidateChars,
      handoff_chars: preparedState.handoffChars,
      compressed: preparedState.compressed,
      force: true,
    });
  }

  const recoveryRequest = recovery.route === 'final_channel'
    ? buildManagedFinalChannelRecoveryRequest(request, response)
    : buildManagedContinuationRecoveryRequest(request, response, preparedState);
  const recoveredResponse = await upstream(recoveryRequest, signal);
  const recoveredInspection = await inspectFinal(recoveredResponse, {
    onDiagnostic, round, repair: true,
  });
  if (recoveredInspection.valid) {
    await onDiagnostic('managed_final_response_repair_success', {
      round,
      recovery_route: recovery.route,
      tools_preserved: recovery.tools_preserved,
      text_bytes: recoveredInspection.text_bytes,
      thinking_bytes: recoveredInspection.thinking_bytes,
      tool_use_count: recoveredInspection.tool_use_count,
    });
    return { response: recoveredResponse, recovered: true, recovery };
  }

  if (logProtocolSnippets) {
    await emitDetailedFinalDiagnostics(recoveryRequest, recoveredResponse, recoveredInspection, {
      onDiagnostic, writeProtocolDiagnostics, round, repair: true, includeInput: false,
    });
  }

  await onDiagnostic('managed_final_response_rejected', {
    round,
    recovery_route: recovery.route,
    tools_preserved: recovery.tools_preserved,
    reasons: recoveredInspection.reasons,
    control_tag_count: recoveredInspection.control_tag_count,
    control_tag_counts: recoveredInspection.control_tag_counts,
  });
  throw new HttpError(502, 'Base model did not produce a valid next action after one recovery attempt.', {
    code: 'response_recovery_exhausted',
    retryable: true,
    details: { recovery_route: recovery.route },
  });
}


function toolResultOnlyMessage(message) {
  return message?.role === 'user'
    && Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block?.type === 'tool_result');
}

function findPendingServerContinuation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let assistantIndex = -1;
  let userIndex = -1;
  const lastIndex = messages.length - 1;
  if (toolResultOnlyMessage(messages[lastIndex]) && messages[lastIndex - 1]?.role === 'assistant') {
    assistantIndex = lastIndex - 1;
    userIndex = lastIndex;
  } else if (messages[lastIndex]?.role === 'assistant') {
    assistantIndex = lastIndex;
  } else {
    return null;
  }
  const content = Array.isArray(messages[assistantIndex]?.content) ? messages[assistantIndex].content : [];
  const completedIds = new Set(content
    .filter((block) => ['web_search_tool_result', 'web_fetch_tool_result'].includes(block?.type))
    .map((block) => block?.tool_use_id)
    .filter(Boolean));
  const pending = content.filter((block) => block?.type === 'server_tool_use'
    && canonicalWebToolName(block?.name)
    && typeof block?.id === 'string'
    && !completedIds.has(block.id));
  if (pending.length === 0) return null;
  if (userIndex >= 0) {
    const clientIds = new Set(content.filter((block) => block?.type === 'tool_use').map((block) => block?.id).filter(Boolean));
    const returned = messages[userIndex].content.map((block) => block?.tool_use_id).filter(Boolean);
    if (!returned.some((id) => clientIds.has(id))) return null;
  }
  return { assistantIndex, userIndex, pending };
}

function addServerUsage(response, counts) {
  const webSearchRequests = counts.WebSearch || 0;
  const webFetchRequests = counts.WebFetch || 0;
  if (!webSearchRequests && !webFetchRequests) return response;
  const usage = { ...(response?.usage || {}) };
  usage.server_tool_use = { ...(usage.server_tool_use || {}) };
  if (webSearchRequests) usage.server_tool_use.web_search_requests = (usage.server_tool_use.web_search_requests || 0) + webSearchRequests;
  if (webFetchRequests) usage.server_tool_use.web_fetch_requests = (usage.server_tool_use.web_fetch_requests || 0) + webFetchRequests;
  return { ...response, usage };
}

function withExternalServerPrefix(response, prefixBlocks, counts, liveServerEvents, materializeServerToolBlocks) {
  let result = addServerUsage(response, counts);
  if (materializeServerToolBlocks && !liveServerEvents && prefixBlocks.length > 0) {
    result = { ...result, content: [...prefixBlocks.map((block) => structuredClone(block)), ...(result.content || [])] };
  }
  return result;
}

function deferMixedServerTools(response) {
  let changed = false;
  const content = (response.content || []).map((block) => {
    if (block?.type !== 'tool_use' || !isManagedToolName(block?.name)) return block;
    const server = createServerWebToolUse(block);
    if (!server) return block;
    changed = true;
    return server.block;
  });
  return changed ? { ...response, content, stop_reason: 'tool_use' } : response;
}

export async function runManagedLoop(initialRequest, {
  upstream,
  executeTool,
  maxRounds = 6,
  onProgress = () => {},
  onDiagnostic = () => {},
  onServerToolEvent = null,
  materializeServerToolBlocks = false,
  showInitialModelProgress = true,
  logProtocolSnippets = false,
  writeProtocolDiagnostics,
  diagnosticPassthroughWebTools,
  passthroughManagedWebTools = false,
  localToolSearch = null,
  onManagedWebToolHandoff = () => {},
  onTrace = () => {},
  signal,
  taskTimeoutMs = DEFAULT_MANAGED_TASK_TIMEOUT_MS,
  modelRoundTimeoutMs = DEFAULT_MODEL_ROUND_TIMEOUT_MS,
  locale = 'zh-TW',
  releaseForcedManagedToolChoiceAfterUse = false,
  modelStallTimeoutMs = DEFAULT_MODEL_STALL_TIMEOUT_MS,
  modelToolStallTimeoutMs = modelStallTimeoutMs > 0 ? Math.max(DEFAULT_TOOL_STALL_TIMEOUT_MS, modelStallTimeoutMs * 3) : 0,
  maxStallRecoveryRounds = DEFAULT_MAX_STALL_RECOVERY_ROUNDS,
  modelResponseMode = 'auto',
  getUpstreamActivity = null,
  onModelRoundState = () => {},
  compressContinuationWindow = null,
  maxCompletionProbesPerCandidate = DEFAULT_MAX_COMPLETION_PROBES_PER_CANDIDATE,
  completionProbeEnabled = false,
} = {}) {
  const request = structuredClone(initialRequest);
  request.stream = false;
  request.messages = Array.isArray(request.messages) ? request.messages : [];
  const taskStartedAt = Date.now();
  let activeRound = 0;
  let previousManagedActionSignature = null;
  const externalServerPrefix = [];
  const serverUsageCounts = { WebSearch: 0, WebFetch: 0 };
  const liveServerEvents = typeof onServerToolEvent === 'function';
  let candidateFinal = null;
  const completionProbeAttempts = new Map();
  const completionProbeLimit = Math.min(
    DEFAULT_MAX_COMPLETION_PROBES_PER_CANDIDATE,
    Math.max(1, Math.floor(Number(maxCompletionProbesPerCandidate) || DEFAULT_MAX_COMPLETION_PROBES_PER_CANDIDATE)),
  );

  const publishServerBlock = async (phase, block) => {
    if (liveServerEvents) await onServerToolEvent({ phase, block: structuredClone(block) });
    else externalServerPrefix.push(structuredClone(block));
  };

  const taskDeadlineEnabled = Number.isFinite(taskTimeoutMs) && taskTimeoutMs > 0;
  const remainingTaskMs = () => taskDeadlineEnabled
    ? taskTimeoutMs - (Date.now() - taskStartedAt)
    : Number.POSITIVE_INFINITY;
  const containedUpstream = async (body, upstreamSignal, containmentOptions = {}) => {
    const hiddenCompletionProbe = containmentOptions?.hiddenCompletionProbe === true;
    const remaining = remainingTaskMs();
    if (taskDeadlineEnabled && remaining <= 0) {
      throw managedTimeoutError('managed_task_timeout', taskTimeoutMs, 'model');
    }
    await onTrace('base_model_request', {
      round: activeRound,
      timeout_ms: modelRoundTimeoutMs,
      first_byte_timeout_ms: modelRoundTimeoutMs,
      task_timeout_ms: taskDeadlineEnabled ? taskTimeoutMs : 0,
      task_remaining_ms: taskDeadlineEnabled ? Math.max(0, remaining) : null,
      request: structuredClone(body),
    });
    const recoveryLimit = Math.max(0, Math.floor(Number(maxStallRecoveryRounds) || 0));
    let recoveryAttempt = 0;
    let toolInputRecoveryAttempt = 0;
    let lastToolInputRecoveryReason = null;
    const streamLoopRecoveryAttempts = { thinking: 0, response: 0 };
    let lastStreamLoopRecoveryKind = null;
    let attemptRequest = body;
    let preservedBlocks = [];
    let latestCheckpoint = null;
    let rawResponse;

    while (true) {
      let attemptCheckpoint = null;
      const runModel = (modelSignal) => runModelWithActivityDeadline(
        (boundedSignal) => upstream(attemptRequest, boundedSignal, {
          onCheckpoint: (checkpoint) => { attemptCheckpoint = structuredClone(checkpoint); },
          ...(hiddenCompletionProbe ? { hiddenCompletionProbe: true } : {}),
        }),
        {
          signal: modelSignal,
          timeoutMs: modelRoundTimeoutMs,
          timeoutCode: 'managed_model_timeout',
          stallTimeoutMs: modelStallTimeoutMs,
          toolStallTimeoutMs: modelToolStallTimeoutMs,
          responseMode: modelResponseMode,
          getUpstreamActivity,
          onRoundState: hiddenCompletionProbe ? () => {} : onModelRoundState,
          round: activeRound,
        },
      );
      try {
        rawResponse = taskDeadlineEnabled
          ? await runWithBoundedTime(
            (taskSignal) => runModel(taskSignal),
            {
              signal: upstreamSignal,
              timeoutMs: Math.max(1, remainingTaskMs()),
              timeoutCode: 'managed_task_timeout',
              phase: 'model',
            },
          )
          : await runModel(upstreamSignal);
        if (recoveryAttempt > 0 || toolInputRecoveryAttempt > 0
          || streamLoopRecoveryAttempts.thinking > 0 || streamLoopRecoveryAttempts.response > 0) {
          rawResponse = mergeManagedStallRecoveryResponse(preservedBlocks, rawResponse);
        }
        if (recoveryAttempt > 0) {
          await onDiagnostic('managed_model_stall_recovery_completed', {
            round: activeRound,
            recovery_attempt: recoveryAttempt,
            preserved_block_count: preservedBlocks.length,
            final_block_types: Array.isArray(rawResponse?.content) ? rawResponse.content.map((block) => String(block?.type || 'unknown')) : [],
          });
        }
        if (toolInputRecoveryAttempt > 0) {
          await onDiagnostic('managed_tool_input_recovery_completed', {
            round: activeRound,
            recovery_attempt: toolInputRecoveryAttempt,
            reason: lastToolInputRecoveryReason,
            preserved_block_count: preservedBlocks.length,
            final_block_types: Array.isArray(rawResponse?.content) ? rawResponse.content.map((block) => String(block?.type || 'unknown')) : [],
          });
        }
        if (lastStreamLoopRecoveryKind) {
          await onDiagnostic('managed_stream_loop_recovery_completed', {
            round: activeRound,
            kind: lastStreamLoopRecoveryKind,
            recovery_attempt: streamLoopRecoveryAttempts[lastStreamLoopRecoveryKind],
            preserved_block_count: preservedBlocks.length,
            final_block_types: Array.isArray(rawResponse?.content) ? rawResponse.content.map((block) => String(block?.type || 'unknown')) : [],
          });
        }
        break;
      } catch (error) {
        const semanticCheckpointAvailable = Boolean(attemptCheckpoint || latestCheckpoint);
        const streamLoopFailure = classifyManagedStreamLoopFailure(error);
        if (streamLoopFailure) {
          if (streamLoopRecoveryAttempts[streamLoopFailure] >= 1) throw exhaustedStreamLoopRecoveryError(streamLoopFailure, error);
          if (!semanticCheckpointAvailable || upstreamSignal?.aborted) throw error;
          latestCheckpoint = attemptCheckpoint || latestCheckpoint;
          preservedBlocks = mergeRecoveryBlocks(preservedBlocks, recoverableCheckpointBlocks(attemptCheckpoint));
          streamLoopRecoveryAttempts[streamLoopFailure] += 1;
          lastStreamLoopRecoveryKind = streamLoopFailure;
          attemptRequest = buildManagedStreamLoopRecoveryRequest(body, preservedBlocks, latestCheckpoint, streamLoopFailure);
          await onDiagnostic('managed_stream_loop_recovery_started', {
            round: activeRound,
            kind: streamLoopFailure,
            recovery_attempt: streamLoopRecoveryAttempts[streamLoopFailure],
            recovery_limit: 1,
            preserved_block_count: preservedBlocks.length,
            preserved_tool_count: preservedBlocks.filter((block) => block?.type === 'tool_use').length,
            partial_block_type: latestCheckpoint?.partial_block?.type || '',
            accumulated_bytes: Number(error?.details?.accumulated_bytes || 0),
            repeated_period_tokens: Number(error?.details?.repeated_period_tokens || 0),
          });
          continue;
        }
        const toolInputFailure = classifyManagedToolInputFailure(error);
        if (toolInputFailure) {
          if (toolInputRecoveryAttempt >= 1) throw exhaustedToolInputRecoveryError(toolInputFailure, error);
          if (!semanticCheckpointAvailable || upstreamSignal?.aborted) throw error;
          latestCheckpoint = attemptCheckpoint || latestCheckpoint;
          preservedBlocks = mergeRecoveryBlocks(preservedBlocks, recoverableCheckpointBlocks(attemptCheckpoint));
          toolInputRecoveryAttempt += 1;
          lastToolInputRecoveryReason = toolInputFailure;
          attemptRequest = buildManagedToolInputRecoveryRequest(body, preservedBlocks, latestCheckpoint, toolInputFailure);
          await onDiagnostic('managed_tool_input_recovery_started', {
            round: activeRound,
            recovery_attempt: toolInputRecoveryAttempt,
            recovery_limit: 1,
            reason: toolInputFailure,
            preserved_block_count: preservedBlocks.length,
            preserved_tool_count: preservedBlocks.filter((block) => block?.type === 'tool_use').length,
            partial_block_type: latestCheckpoint?.partial_block?.type || '',
            partial_tool_name: latestCheckpoint?.partial_block?.name || error?.details?.tool_name || '',
            partial_json_bytes: Number(error?.details?.partial_json_bytes || 0),
            output_tokens: Number.isFinite(Number(error?.details?.output_tokens)) ? Number(error.details.output_tokens) : null,
            max_tokens: Number.isFinite(Number(error?.details?.max_tokens)) ? Number(error.details.max_tokens) : null,
          });
          continue;
        }
        const stall = error instanceof HttpError && error.code === 'managed_model_stall_timeout';
        if (!stall || !semanticCheckpointAvailable || recoveryAttempt >= recoveryLimit || upstreamSignal?.aborted) throw error;
        latestCheckpoint = attemptCheckpoint || latestCheckpoint;
        preservedBlocks = mergeRecoveryBlocks(preservedBlocks, recoverableCheckpointBlocks(attemptCheckpoint));
        recoveryAttempt += 1;
        attemptRequest = buildManagedStallRecoveryRequest(body, preservedBlocks, latestCheckpoint, recoveryAttempt, recoveryLimit);
        await onDiagnostic('managed_model_stall_recovery_started', {
          round: activeRound,
          recovery_attempt: recoveryAttempt,
          recovery_limit: recoveryLimit,
          stalled_phase: latestCheckpoint?.phase || error?.details?.stream_phase || 'unknown',
          preserved_block_count: preservedBlocks.length,
          preserved_tool_count: preservedBlocks.filter((block) => block?.type === 'tool_use').length,
          partial_block_type: latestCheckpoint?.partial_block?.type || '',
          partial_tool_name: latestCheckpoint?.partial_block?.name || '',
          idle_ms: error?.details?.idle_ms || 0,
          timeout_ms: error?.details?.timeout_ms || error?.details?.tool_stall_timeout_ms || modelStallTimeoutMs,
        });
        await onProgress(statusText(locale, 'modelStallRecovery', {
          attempt: recoveryAttempt,
          total: recoveryLimit,
          phase: latestCheckpoint?.phase || 'unknown',
        }), {
          phase: 'managed_model_stall_recovery',
          attempt: recoveryAttempt,
          total: recoveryLimit,
          model_phase: latestCheckpoint?.phase || 'unknown',
          force: true,
        });
      }
    }

    await onTrace('base_model_response', {
      round: activeRound,
      response: structuredClone(rawResponse),
    });
    const normalized = normalizeNativeWebToolResponse(rawResponse);
    if (normalized.changed) {
      await onDiagnostic('native_web_response_contained', {
        round: activeRound,
        server_tool_use_count: normalized.serverToolUseCount,
        stripped_result_count: normalized.strippedResultCount,
        original_block_types: Array.isArray(rawResponse?.content)
          ? rawResponse.content.map((block) => String(block?.type || 'unknown'))
          : [],
      });
    }
    return normalized.response;
  };


  const pendingContinuation = findPendingServerContinuation(request.messages);
  if (pendingContinuation) {
    const syntheticResults = [];
    for (const pendingBlock of pendingContinuation.pending) {
      const canonical = canonicalWebToolName(pendingBlock.name);
      const internalToolUse = {
        type: 'tool_use', id: pendingBlock.id,
        name: canonical === 'WebSearch' ? 'web_search' : 'web_fetch',
        input: pendingBlock.input && typeof pendingBlock.input === 'object' ? structuredClone(pendingBlock.input) : {},
      };
      await onProgress(progressMessage(internalToolUse.name, internalToolUse.input, 'start', locale), {
        phase: 'managed_server_tool_resume_start', name: canonical, round: 0, force: true,
      });
      let output = null;
      let error = null;
      try {
        const remaining = remainingTaskMs();
        if (taskDeadlineEnabled && remaining <= 0) throw managedTimeoutError('managed_task_timeout', taskTimeoutMs, 'tool');
        output = taskDeadlineEnabled
          ? await runWithBoundedTime(
            (boundedSignal) => executeTool(internalToolUse, boundedSignal),
            { signal, timeoutMs: Math.max(1, remaining), timeoutCode: 'managed_task_timeout', phase: 'tool' },
          )
          : await executeTool(internalToolUse, signal);
        serverUsageCounts[canonical] += 1;
      } catch (caught) {
        if (caught instanceof HttpError && caught.code === 'managed_task_timeout') throw caught;
        if (!(caught instanceof HttpError)) throw caught;
        error = caught;
      }
      const serverResult = createServerWebToolResult(canonical, pendingBlock.id, output, error);
      await publishServerBlock('result', serverResult);
      const neutralOutput = error ? safeToolError(error) : neutralizeProtocolValue(output);
      syntheticResults.push({
        type: 'tool_result',
        tool_use_id: pendingBlock.id,
        ...(error ? { is_error: true } : {}),
        content: error
          ? JSON.stringify(neutralizeProtocolValue(neutralOutput))
          : renderManagedToolResult(internalToolUse.name, neutralOutput),
      });
      await onProgress(progressMessage(internalToolUse.name, internalToolUse.input, error ? 'error' : 'done', locale), {
        phase: error ? 'managed_server_tool_resume_error' : 'managed_server_tool_resume_done',
        name: canonical, round: 0,
      });
    }
    const assistant = request.messages[pendingContinuation.assistantIndex];
    assistant.content = assistant.content.map((block) => {
      if (block?.type !== 'server_tool_use' || !pendingContinuation.pending.some((pending) => pending.id === block.id)) return block;
      const canonical = canonicalWebToolName(block.name);
      return {
        type: 'tool_use', id: block.id,
        name: canonical === 'WebSearch' ? 'web_search' : 'web_fetch',
        input: block.input && typeof block.input === 'object' ? structuredClone(block.input) : {},
      };
    });
    if (pendingContinuation.userIndex >= 0) {
      request.messages[pendingContinuation.userIndex].content.push(...syntheticResults);
    } else {
      request.messages.push({ role: 'user', content: syntheticResults });
    }
    injectManagedWebResultInstruction(request);
  }

  const completedServerHistory = sanitizeCompletedServerWebHistory(request.messages);
  if (completedServerHistory.changed) {
    request.messages = completedServerHistory.messages;
    await onDiagnostic('server_web_completed_history_sanitized', {
      completed_count: completedServerHistory.completed_count,
    });
  }

  for (let round = 0; round < maxRounds; round += 1) {
    activeRound = round + 1;
    if (round > 0 || showInitialModelProgress) {
      await onProgress(
        round === 0 ? statusText(locale, 'modelPlanning') : statusText(locale, 'modelToolResults'),
        { phase: 'managed_model_round_start', round: round + 1 },
      );
    }
    let response = await containedUpstream(request, signal);
    let recovery = null;
    const recovered = await recoverInvalidResponse(request, response, {
      upstream: containedUpstream, signal, onDiagnostic, onProgress, round: round + 1, logProtocolSnippets,
      writeProtocolDiagnostics, locale, compressContinuationWindow,
    });
    response = recovered.response;
    recovery = recovered.recovery;
    if (Array.isArray(response?.content)) {
      const normalizedContent = response.content.map((block) => normalizeManagedToolUseBlock(block));
      if (normalizedContent.some((block, index) => block !== response.content[index])) {
        response = { ...response, content: normalizedContent };
      }
    }
    let toolUses = Array.isArray(response?.content)
      ? response.content.filter((block) => block?.type === 'tool_use')
      : [];
    if (completionProbeEnabled && response?.stop_reason === 'end_turn' && toolUses.length === 0) {
      candidateFinal = structuredClone(response);
      const candidateKey = completionCandidateKey(candidateFinal);
      const probeAttempt = (completionProbeAttempts.get(candidateKey) || 0) + 1;
      if (probeAttempt > completionProbeLimit) {
        const error = new HttpError(422, 'Completion probe limit reached for the same candidate final.', {
          code: 'completion_probe_limit',
          retryable: false,
          details: { probe_limit: completionProbeLimit },
        });
        await onDiagnostic('completion_probe_failed', {
          round: round + 1,
          probe_attempt: probeAttempt,
          probe_limit: completionProbeLimit,
          code: error.code,
          ...candidateTelemetry(candidateFinal),
        });
        candidateFinal = null;
        throw error;
      }
      completionProbeAttempts.set(candidateKey, probeAttempt);
      const probeRequest = buildCompletionProbeRequest(request, candidateFinal);
      await onDiagnostic('completion_probe_started', {
        round: round + 1,
        probe_attempt: probeAttempt,
        probe_limit: completionProbeLimit,
        ...candidateTelemetry(candidateFinal),
      });
      let probeResponse;
      try {
        probeResponse = await containedUpstream(probeRequest, signal, { hiddenCompletionProbe: true });
      } catch (error) {
        await onDiagnostic('completion_probe_failed', {
          round: round + 1,
          probe_attempt: probeAttempt,
          probe_limit: completionProbeLimit,
          code: String(error?.code || error?.name || 'completion_probe_failed'),
          ...candidateTelemetry(candidateFinal),
        });
        candidateFinal = null;
        throw error;
      }
      if (Array.isArray(probeResponse?.content)) {
        const normalizedContent = probeResponse.content.map((block) => normalizeManagedToolUseBlock(block));
        if (normalizedContent.some((block, index) => block !== probeResponse.content[index])) {
          probeResponse = { ...probeResponse, content: normalizedContent };
        }
      }
      const probeToolUses = normalizedToolUses(probeResponse);
      if (probeToolUses.length === 0) {
        await onDiagnostic('completion_probe_confirmed_final', {
          round: round + 1,
          probe_attempt: probeAttempt,
          probe_limit: completionProbeLimit,
          probe_stop_reason: probeResponse?.stop_reason ?? null,
          ...candidateTelemetry(candidateFinal),
        });
        const confirmed = candidateFinal;
        candidateFinal = null;
        return withExternalServerPrefix(confirmed, externalServerPrefix, serverUsageCounts, liveServerEvents, materializeServerToolBlocks);
      }
      await onDiagnostic('completion_probe_continuation', {
        round: round + 1,
        probe_attempt: probeAttempt,
        probe_limit: completionProbeLimit,
        tool_use_count: probeToolUses.length,
        tool_names: probeToolUses.map((block) => String(block?.name || '')),
        ...candidateTelemetry(candidateFinal),
      });
      request.messages = structuredClone(probeRequest.messages);
      candidateFinal = null;
      response = probeResponse;
      toolUses = probeToolUses;
    } else if (toolUses.length === 0) {
      return withExternalServerPrefix(response, externalServerPrefix, serverUsageCounts, liveServerEvents, materializeServerToolBlocks);
    }

    const toolSearchUses = localToolSearch?.enabled
      ? toolUses.filter((block) => isToolSearchToolName(block?.name))
      : [];
    if (toolSearchUses.length > 0) {
      const searchResults = [];
      let disableSearch = false;
      for (const toolUse of toolSearchUses) {
        const result = executeLocalToolSearch(localToolSearch, toolUse);
        if (!result) continue;
        disableSearch = disableSearch || result.exhausted;
        searchResults.push(createLocalToolSearchResult(toolUse, result));
        await onDiagnostic('local_tool_search_executed', {
          round: round + 1,
          variant: result.variant,
          query: result.query,
          requested_limit: result.limit,
          matched_tool_count: result.matches.length,
          matched_tool_names: result.matches,
          newly_materialized_count: result.newlyMaterialized.length,
          newly_materialized_tool_names: result.newlyMaterialized,
          search_budget_exhausted: result.exhausted,
          ...(result.error ? { error_code: result.error.code, error_message: result.error.message } : {}),
          ...localToolSearchStateSnapshot(localToolSearch),
        });
      }
      const deferredClientToolUses = toolUses.filter((block) => !isToolSearchToolName(block?.name));
      if (deferredClientToolUses.length > 0) {
        await onDiagnostic('local_tool_search_mixed_client_tools_deferred', {
          round: round + 1,
          client_tool_names: deferredClientToolUses.map((block) => String(block?.name || '')),
        });
      }
      request.messages.push({
        role: 'assistant',
        content: (Array.isArray(response?.content) ? response.content : [])
          .filter((block) => block?.type !== 'tool_use' || isToolSearchToolName(block?.name))
          .map((block) => structuredClone(block)),
      });
      request.messages.push({ role: 'user', content: searchResults });
      const materializedRequest = materializeLocalToolSearchTools(request, localToolSearch, { disableSearch });
      request.tools = materializedRequest.tools;
      if (request.tool_choice?.type === 'tool' && isToolSearchToolName(request.tool_choice?.name)) {
        request.tool_choice = { type: 'auto' };
      }
      continue;
    }
    if (typeof diagnosticPassthroughWebTools === 'function' && toolUses.some((block) => isManagedToolName(block.name))) {
      const decision = await diagnosticPassthroughWebTools({
        round: round + 1,
        response: structuredClone(response),
        toolUses: structuredClone(toolUses),
      });
      if (decision?.passthrough === true) {
        await onTrace('diagnostic_web_tool_passthrough', {
          round: round + 1,
          decision: structuredClone(decision),
          response: structuredClone(response),
        });
        await onDiagnostic('diagnostic_web_tool_passthrough', {
          round: round + 1,
          tool_names: toolUses.map((block) => String(block?.name || '')),
          tool_ids: toolUses.map((block) => String(block?.id || '')),
        });
        return response;
      }
    }
    if (passthroughManagedWebTools && toolUses.some((block) => isManagedToolName(block.name))) {
      await onManagedWebToolHandoff({
        round: round + 1,
        response: structuredClone(response),
        toolUses: structuredClone(toolUses),
      });
      await onDiagnostic('client_web_tool_handoff', {
        round: round + 1,
        tool_names: toolUses.filter((block) => isManagedToolName(block.name)).map((block) => String(block?.name || '')),
        tool_ids: toolUses.filter((block) => isManagedToolName(block.name)).map((block) => String(block?.id || '')),
      });
      return response;
    }
    if (toolUses.some((block) => !isManagedToolName(block.name))) {
      const managedToolNames = toolUses.filter((block) => isManagedToolName(block.name)).map((block) => normalizeManagedToolName(block.name));
      if (managedToolNames.length > 0) {
        const deferred = deferMixedServerTools(response);
        await onDiagnostic('server_web_mixed_tool_deferred', {
          round: round + 1,
          server_tool_names: managedToolNames,
          client_tool_names: toolUses.filter((block) => !isManagedToolName(block.name)).map((block) => String(block?.name || '')),
        });
        return withExternalServerPrefix(deferred, externalServerPrefix, serverUsageCounts, liveServerEvents, materializeServerToolBlocks);
      }
      if (recovery) {
        await onDiagnostic('managed_final_response_recovery_tool_dispatch', {
          round: round + 1,
          recovery_route: recovery.route,
          disposition: 'unmanaged',
          tool_names: toolUses.map((block) => String(block?.name || '')),
        });
      }
      return withExternalServerPrefix(response, externalServerPrefix, serverUsageCounts, liveServerEvents, materializeServerToolBlocks);
    }
    const actionSignature = managedActionSignature(toolUses);
    if (previousManagedActionSignature === actionSignature) {
      await onDiagnostic('managed_no_progress_detected', {
        round: round + 1,
        tool_names: toolUses.map((block) => normalizeManagedToolName(block.name)),
      });
      throw new HttpError(422, 'Managed tool loop repeated the exact same action without progress.', {
        code: 'managed_no_progress',
        retryable: false,
      });
    }
    previousManagedActionSignature = actionSignature;

    if (recovery) {
      await onDiagnostic('managed_final_response_recovery_tool_dispatch', {
        round: round + 1,
        recovery_route: recovery.route,
        disposition: 'managed',
        tool_names: toolUses.map((block) => normalizeManagedToolName(block.name)),
      });
    }

    const serverCalls = toolUses.map((toolUse) => createServerWebToolUse(toolUse));
    for (const serverCall of serverCalls) {
      if (serverCall) await publishServerBlock('use', serverCall.block);
    }

    const results = await Promise.all(toolUses.map(async (toolUse, toolIndex) => {
      await onProgress(progressMessage(toolUse.name, toolUse.input, 'start', locale), {
        phase: 'managed_tool_start', name: normalizeManagedToolName(toolUse.name), round: round + 1, force: true,
      });
      try {
        const remaining = remainingTaskMs();
        if (taskDeadlineEnabled && remaining <= 0) throw managedTimeoutError('managed_task_timeout', taskTimeoutMs, 'tool');
        const output = taskDeadlineEnabled
          ? await runWithBoundedTime(
            (boundedSignal) => executeTool(toolUse, boundedSignal),
            { signal, timeoutMs: Math.max(1, remaining), timeoutCode: 'managed_task_timeout', phase: 'tool' },
          )
          : await executeTool(toolUse, signal);
        const inventory = inventoryProtocolTags(output);
        if (inventory.total > 0) {
          await onDiagnostic('managed_tool_result_protocol_inventory', {
            name: normalizeManagedToolName(toolUse.name),
            round: round + 1,
            tag_count: inventory.total,
            tag_counts: inventory.counts,
          });
        }
        const neutralOutput = neutralizeProtocolValue(output);
        const canonical = normalizeManagedToolName(toolUse.name);
        const serverCall = serverCalls[toolIndex];
        if (serverCall) {
          const serverResult = createServerWebToolResult(canonical, serverCall.id, neutralOutput);
          await publishServerBlock('result', serverResult);
          serverUsageCounts[canonical] += 1;
        }
        await onProgress(progressMessage(toolUse.name, toolUse.input, 'done', locale), {
          phase: 'managed_tool_done', name: normalizeManagedToolName(toolUse.name), round: round + 1,
        });
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: renderManagedToolResult(toolUse.name, neutralOutput),
        };
      } catch (error) {
        if (error instanceof HttpError && error.code === 'managed_task_timeout') throw error;
        if (!(error instanceof HttpError)) throw error;
        const canonical = normalizeManagedToolName(toolUse.name);
        const serverCall = serverCalls[toolIndex];
        if (serverCall) {
          const serverResult = createServerWebToolResult(canonical, serverCall.id, null, error);
          await publishServerBlock('result', serverResult);
        }
        await onProgress(progressMessage(toolUse.name, toolUse.input, 'error', locale), {
          phase: 'managed_tool_error', name: canonical, round: round + 1,
          code: error.code,
        });
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: JSON.stringify(neutralizeProtocolValue(safeToolError(error))),
        };
      }
    }));

    request.messages.push({ role: 'assistant', content: structuredClone(response.content) });
    request.messages.push({ role: 'user', content: results });
    injectManagedWebResultInstruction(request);

    if (releaseForcedManagedToolChoiceAfterUse
      && request.tool_choice?.type === 'tool'
      && isManagedToolName(request.tool_choice?.name)) {
      request.tool_choice = { type: 'auto' };
      await onDiagnostic('managed_forced_tool_choice_satisfied', {
        round: round + 1,
        tool_name: normalizeManagedToolName(toolUses[0]?.name),
      });
    }

    if (taskDeadlineEnabled && remainingTaskMs() <= modelRoundTimeoutMs && Array.isArray(request.tools)) {
      const before = request.tools.length;
      request.tools = request.tools.filter((tool) => !isManagedToolName(tool?.name));
      const removed = before - request.tools.length;
      if (removed > 0) {
        if (request.tool_choice?.type === 'tool' && isManagedToolName(request.tool_choice?.name)) {
          request.tool_choice = { type: 'auto' };
        }
        await onDiagnostic('managed_final_round_reserved', {
          round: round + 1,
          remaining_ms: Math.max(0, remainingTaskMs()),
          reserve_ms: modelRoundTimeoutMs,
          managed_tools_removed: removed,
        });
        await onProgress(statusText(locale, 'finalRoundReserved'), {
          phase: 'managed_final_round_reserved', round: round + 1,
        });
      }
    }
  }

  throw new HttpError(422, 'Reached the maximum managed tool rounds.', {
    code: 'managed_tool_loop_limit',
    retryable: false,
  });
}
