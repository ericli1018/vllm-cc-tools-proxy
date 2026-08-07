import { HttpError } from '../lib/http.js';
import {
  buildManagedContinuationRecoveryRequest,
  buildManagedFinalChannelRecoveryRequest,
  classifyManagedRecovery,
  inspectManagedFinalResponse,
} from './managed-final.js';
import { inventoryProtocolTags, neutralizeProtocolValue } from './protocol-sanitizer.js';
import { isManagedToolName, normalizeManagedToolName, normalizeManagedToolUseBlock } from './web-tools.js';
import { normalizeNativeWebToolResponse, isResponseSideNativeWebToolUse } from './native-web-tools.js';
import { injectManagedWebResultInstruction, renderManagedToolResult } from './web-result-contract.js';
import { collectRequestProtocolSnippets, collectResponseAnomalySnippets } from './protocol-diagnostics.js';


const DEFAULT_MANAGED_TASK_TIMEOUT_MS = 1_800_000;
const DEFAULT_MODEL_ROUND_TIMEOUT_MS = 360_000;

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

function managedTimeoutError(code, timeoutMs, phase) {
  const task = code === 'managed_task_timeout';
  return new HttpError(504, task
    ? 'Managed task exceeded its total execution deadline.'
    : 'Base model did not complete the managed round within the bounded model deadline.', {
    code,
    retryable: true,
    details: { timeout_ms: timeoutMs, phase },
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

function progressMessage(name, input, phase) {
  const normalized = normalizeManagedToolName(name);
  if (normalized === 'WebSearch') {
    const query = String(input?.query ?? input?.q ?? '').slice(0, 160);
    return phase === 'start' ? `正在搜尋：${query}…` : `搜尋完成：${query}。`;
  }
  if (normalized === 'WebFetch') {
    let host = '網頁';
    try { host = new URL(input?.url).host; } catch {}
    if (phase === 'start') return `正在讀取並整理 ${host}…`;
    if (phase === 'error') return `${host} 讀取失敗；正在交由主模型改用其他來源。`;
    return `${host} 內容已就緒。`;
  }
  return '正在執行工具…';
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
  writeProtocolDiagnostics,
}) {
  const inspection = await inspectFinal(response, { onDiagnostic, round, repair: false });
  if (inspection.valid) return { response, recovered: false, recovery: null };

  if (logProtocolSnippets) {
    await emitDetailedFinalDiagnostics(request, response, inspection, {
      onDiagnostic, writeProtocolDiagnostics, round, repair: false, includeInput: true,
    });
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
      ? '主模型答案通道異常；正在進行一次短格式修正…'
      : '主模型未產生有效下一步；正在進行一次受控續接…',
    {
      phase: recovery.route === 'final_channel'
        ? 'managed_final_channel_recovery_start'
        : 'managed_continuation_recovery_start',
      round,
      recovery_route: recovery.route,
      force: true,
    },
  );

  const recoveryRequest = recovery.route === 'final_channel'
    ? buildManagedFinalChannelRecoveryRequest(request, response)
    : buildManagedContinuationRecoveryRequest(request, response);
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

export async function runManagedLoop(initialRequest, {
  upstream,
  executeTool,
  maxRounds = 6,
  onProgress = () => {},
  onDiagnostic = () => {},
  showInitialModelProgress = true,
  logProtocolSnippets = false,
  writeProtocolDiagnostics,
  signal,
  taskTimeoutMs = DEFAULT_MANAGED_TASK_TIMEOUT_MS,
  modelRoundTimeoutMs = DEFAULT_MODEL_ROUND_TIMEOUT_MS,
} = {}) {
  const request = structuredClone(initialRequest);
  request.stream = false;
  request.messages = Array.isArray(request.messages) ? request.messages : [];
  const taskStartedAt = Date.now();
  let activeRound = 0;
  let previousManagedActionSignature = null;

  const remainingTaskMs = () => taskTimeoutMs - (Date.now() - taskStartedAt);
  const containedUpstream = async (body, upstreamSignal) => {
    const remaining = remainingTaskMs();
    if (remaining <= 0) throw managedTimeoutError('managed_task_timeout', taskTimeoutMs, 'model');
    const boundedMs = Math.max(1, Math.min(modelRoundTimeoutMs, remaining));
    const timeoutCode = remaining <= modelRoundTimeoutMs ? 'managed_task_timeout' : 'managed_model_timeout';
    const rawResponse = await runWithBoundedTime(
      (boundedSignal) => upstream(body, boundedSignal),
      { signal: upstreamSignal, timeoutMs: boundedMs, timeoutCode, phase: 'model' },
    );
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

  for (let round = 0; round < maxRounds; round += 1) {
    activeRound = round + 1;
    if (round > 0 || showInitialModelProgress) {
      await onProgress(
        round === 0 ? '正在請主模型規劃下一步…' : '主模型正在整理工具結果…',
        { phase: 'managed_model_round_start', round: round + 1 },
      );
    }
    let response = await containedUpstream(request, signal);
    let recovery = null;
    const recovered = await recoverInvalidResponse(request, response, {
      upstream: containedUpstream, signal, onDiagnostic, onProgress, round: round + 1, logProtocolSnippets,
      writeProtocolDiagnostics,
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
    if (toolUses.length === 0) return response;
    if (toolUses.some((block) => !isManagedToolName(block.name))) {
      const hasResponseSideNativeWebCall = toolUses.some(isResponseSideNativeWebToolUse);
      if (!hasResponseSideNativeWebCall) {
        if (recovery) {
          await onDiagnostic('managed_final_response_recovery_tool_dispatch', {
            round: round + 1,
            recovery_route: recovery.route,
            disposition: 'unmanaged',
            tool_names: toolUses.map((block) => String(block?.name || '')),
          });
        }
        return response;
      }

      const deferredToolNames = toolUses
        .filter((block) => !isManagedToolName(block.name))
        .map((block) => String(block?.name || ''));
      response = {
        ...response,
        content: response.content.filter((block) => block?.type !== 'tool_use' || isManagedToolName(block.name)),
      };
      toolUses = response.content.filter((block) => block?.type === 'tool_use');
      await onDiagnostic('native_web_mixed_tool_deferred', {
        round: round + 1,
        deferred_tool_names: deferredToolNames,
        managed_tool_names: toolUses.map((block) => normalizeManagedToolName(block.name)),
      });
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

    const results = await Promise.all(toolUses.map(async (toolUse) => {
      await onProgress(progressMessage(toolUse.name, toolUse.input, 'start'), {
        phase: 'managed_tool_start', name: normalizeManagedToolName(toolUse.name), round: round + 1, force: true,
      });
      try {
        const remaining = remainingTaskMs();
        if (remaining <= 0) throw managedTimeoutError('managed_task_timeout', taskTimeoutMs, 'tool');
        const output = await runWithBoundedTime(
          (boundedSignal) => executeTool(toolUse, boundedSignal),
          { signal, timeoutMs: Math.max(1, remaining), timeoutCode: 'managed_task_timeout', phase: 'tool' },
        );
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
        await onProgress(progressMessage(toolUse.name, toolUse.input, 'done'), {
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
        await onProgress(progressMessage(toolUse.name, toolUse.input, 'error'), {
          phase: 'managed_tool_error', name: normalizeManagedToolName(toolUse.name), round: round + 1,
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

    if (remainingTaskMs() <= modelRoundTimeoutMs && Array.isArray(request.tools)) {
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
        await onProgress('研究工具預算已停止擴張；保留時間給主模型完成下一步…', {
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
