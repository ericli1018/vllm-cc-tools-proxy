import { HttpError } from '../lib/http.js';
import {
  buildManagedContinuationRecoveryRequest,
  buildManagedFinalChannelRecoveryRequest,
  classifyManagedRecovery,
  inspectManagedFinalResponse,
} from './managed-final.js';
import { inventoryProtocolTags, neutralizeProtocolValue } from './protocol-sanitizer.js';
import { isManagedToolName, normalizeManagedToolName } from './web-tools.js';
import { normalizeNativeWebToolResponse, isResponseSideNativeWebToolUse } from './native-web-tools.js';
import { injectManagedWebResultInstruction, renderManagedToolResult } from './web-result-contract.js';
import { collectRequestProtocolSnippets, collectResponseAnomalySnippets } from './protocol-diagnostics.js';

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
    : buildManagedContinuationRecoveryRequest(request);
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
} = {}) {
  const request = structuredClone(initialRequest);
  request.stream = false;
  request.messages = Array.isArray(request.messages) ? request.messages : [];
  let activeRound = 0;
  const containedUpstream = async (body, upstreamSignal) => {
    const rawResponse = await upstream(body, upstreamSignal);
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
    let toolUses = Array.isArray(response?.content)
      ? response.content.filter((block) => block?.type === 'tool_use')
      : [];
    if (toolUses.length === 0) {
      const recovered = await recoverInvalidResponse(request, response, {
        upstream: containedUpstream, signal, onDiagnostic, onProgress, round: round + 1, logProtocolSnippets,
        writeProtocolDiagnostics,
      });
      if (!recovered.recovered) return recovered.response;
      response = recovered.response;
      recovery = recovered.recovery;
      toolUses = Array.isArray(response?.content)
        ? response.content.filter((block) => block?.type === 'tool_use')
        : [];
      if (toolUses.length === 0) return response;
    }
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
    if (recovery) {
      await onDiagnostic('managed_final_response_recovery_tool_dispatch', {
        round: round + 1,
        recovery_route: recovery.route,
        disposition: 'managed',
        tool_names: toolUses.map((block) => normalizeManagedToolName(block.name)),
      });
    }

    const results = [];
    for (const toolUse of toolUses) {
      await onProgress(progressMessage(toolUse.name, toolUse.input, 'start'), {
        phase: 'managed_tool_start', name: normalizeManagedToolName(toolUse.name), round: round + 1, force: true,
      });
      try {
        const output = await executeTool(toolUse, signal);
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
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: renderManagedToolResult(toolUse.name, neutralOutput),
        });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        await onProgress(progressMessage(toolUse.name, toolUse.input, 'error'), {
          phase: 'managed_tool_error', name: normalizeManagedToolName(toolUse.name), round: round + 1,
          code: error.code,
        });
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: JSON.stringify(neutralizeProtocolValue(safeToolError(error))),
        });
      }
    }

    request.messages.push({ role: 'assistant', content: structuredClone(response.content) });
    request.messages.push({ role: 'user', content: results });
    injectManagedWebResultInstruction(request);
  }

  throw new HttpError(422, 'Reached the maximum managed tool rounds.', {
    code: 'managed_tool_loop_limit',
    retryable: false,
  });
}
