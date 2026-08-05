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
    return phase === 'start' ? `正在讀取 ${host}…` : `${host} 內容已就緒。`;
  }
  return '正在執行工具…';
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
      const output = await executeTool(toolUse, signal);
      await onProgress(progressMessage(toolUse.name, toolUse.input, 'done'), {
        phase: 'managed_tool_done', name: normalizeManagedToolName(toolUse.name), round: round + 1,
      });
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(output),
      });
    }

    request.messages.push({ role: 'assistant', content: structuredClone(response.content) });
    request.messages.push({ role: 'user', content: results });
  }

  throw new HttpError(422, 'Reached the maximum managed tool rounds.', {
    code: 'managed_tool_loop_limit',
    retryable: false,
  });
}
