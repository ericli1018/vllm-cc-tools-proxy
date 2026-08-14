import { statusText } from '../i18n/response-language.js';
import { HttpError } from '../lib/http.js';
import {
  buildManagedContinuationRecoveryRequest,
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


const DEFAULT_MANAGED_TASK_TIMEOUT_MS = 0;
const DEFAULT_MODEL_ROUND_TIMEOUT_MS = 360_000;
const DEFAULT_MODEL_STALL_TIMEOUT_MS = 90_000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function managedActionSignature(toolUses) {
  return JSON.stringify(toolUses.map((toolUse) => ({
    name: normalizeManagedToolName(toolUse?.name),
    input: stableValue(toolUse?.input ?? {}),
  })));
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
    return {
      started: bytes > startBytes && lastByteAt >= startedAt,
      bytes,
      lastByteAt,
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
  const pollMs = Math.max(5, Math.min(1000, Math.floor(stallTimeoutMs / 4) || 5));
  if (typeof getUpstreamActivity === 'function' && stallTimeoutMs > 0) {
    stallTimer = setInterval(() => {
      if (settled) return;
      const activity = currentRoundActivity();
      if (activity.responseMode !== 'streaming') return;
      const idleMs = activity.lastByteAt > 0 ? Math.max(0, Date.now() - activity.lastByteAt) : 0;
      if (!activity.started || idleMs < stallTimeoutMs) return;
      const error = managedTimeoutError('managed_model_stall_timeout', stallTimeoutMs, 'model', {
        response_mode: activity.responseMode,
        received_bytes: activity.bytes,
        idle_ms: idleMs,
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
  onManagedWebToolHandoff = () => {},
  onTrace = () => {},
  signal,
  taskTimeoutMs = DEFAULT_MANAGED_TASK_TIMEOUT_MS,
  modelRoundTimeoutMs = DEFAULT_MODEL_ROUND_TIMEOUT_MS,
  locale = 'zh-TW',
  releaseForcedManagedToolChoiceAfterUse = false,
  modelStallTimeoutMs = DEFAULT_MODEL_STALL_TIMEOUT_MS,
  modelResponseMode = 'auto',
  getUpstreamActivity = null,
  onModelRoundState = () => {},
  compressContinuationWindow = null,
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

  const publishServerBlock = async (phase, block) => {
    if (liveServerEvents) await onServerToolEvent({ phase, block: structuredClone(block) });
    else externalServerPrefix.push(structuredClone(block));
  };

  const taskDeadlineEnabled = Number.isFinite(taskTimeoutMs) && taskTimeoutMs > 0;
  const remainingTaskMs = () => taskDeadlineEnabled
    ? taskTimeoutMs - (Date.now() - taskStartedAt)
    : Number.POSITIVE_INFINITY;
  const containedUpstream = async (body, upstreamSignal) => {
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
    const runModel = (modelSignal) => runModelWithActivityDeadline(
      (boundedSignal) => upstream(body, boundedSignal),
      {
        signal: modelSignal,
        timeoutMs: modelRoundTimeoutMs,
        timeoutCode: 'managed_model_timeout',
        stallTimeoutMs: modelStallTimeoutMs,
        responseMode: modelResponseMode,
        getUpstreamActivity,
        onRoundState: onModelRoundState,
        round: activeRound,
      },
    );
    const rawResponse = taskDeadlineEnabled
      ? await runWithBoundedTime(
        (taskSignal) => runModel(taskSignal),
        {
          signal: upstreamSignal,
          timeoutMs: Math.max(1, remaining),
          timeoutCode: 'managed_task_timeout',
          phase: 'model',
        },
      )
      : await runModel(upstreamSignal);
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
    if (toolUses.length === 0) return withExternalServerPrefix(response, externalServerPrefix, serverUsageCounts, liveServerEvents, materializeServerToolBlocks);
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
