import { HttpError } from '../lib/http.js';
import { isManagedToolName, normalizeManagedToolName } from './web-tools.js';

function progressMessage(name, input, phase) {
  const normalized = normalizeManagedToolName(name);
  if (normalized === 'WebSearch') {
    const query = String(input?.query ?? input?.q ?? '').slice(0, 160);
    return phase === 'start' ? `正在搜尋：${query}…` : `搜尋完成：${query}。`;
  }
  if (normalized === 'WebFetch') {
    let host = '網頁';
    try { host = new URL(input?.url).host; } catch {}
    if (phase === 'start') return `正在讀取 ${host}…`;
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

export async function runManagedLoop(initialRequest, {
  upstream,
  executeTool,
  maxRounds = 6,
  onProgress = () => {},
  signal,
} = {}) {
  const request = structuredClone(initialRequest);
  request.stream = false;
  request.messages = Array.isArray(request.messages) ? request.messages : [];

  for (let round = 0; round < maxRounds; round += 1) {
    await onProgress(
      round === 0 ? '正在請主模型規劃下一步…' : '主模型正在整理工具結果…',
      { phase: 'managed_model_round_start', round: round + 1 },
    );
    const response = await upstream(request, signal);
    const toolUses = Array.isArray(response?.content)
      ? response.content.filter((block) => block?.type === 'tool_use')
      : [];
    if (toolUses.length === 0) return response;
    if (toolUses.some((block) => !isManagedToolName(block.name))) return response;

    const results = [];
    for (const toolUse of toolUses) {
      await onProgress(progressMessage(toolUse.name, toolUse.input, 'start'), {
        phase: 'managed_tool_start', name: normalizeManagedToolName(toolUse.name), round: round + 1,
      });
      try {
        const output = await executeTool(toolUse, signal);
        await onProgress(progressMessage(toolUse.name, toolUse.input, 'done'), {
          phase: 'managed_tool_done', name: normalizeManagedToolName(toolUse.name), round: round + 1,
        });
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(output),
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
          content: JSON.stringify(safeToolError(error)),
        });
      }
    }

    request.messages.push({ role: 'assistant', content: structuredClone(response.content) });
    request.messages.push({ role: 'user', content: results });
  }

  throw new HttpError(422, 'Reached the maximum managed tool rounds.', {
    code: 'managed_tool_loop_limit',
    retryable: false,
  });
}
