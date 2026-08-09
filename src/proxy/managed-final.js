import { inventoryProtocolTags, neutralizeControlTags } from './protocol-sanitizer.js';

const FINAL_CHANNEL_SYSTEM = `You recover a completed answer that was emitted in the model's private reasoning channel.
Return only the user-visible final answer.
Preserve the supplied facts, language, structure, and level of detail.
Do not add new facts.
Do not call tools.
Do not emit reasoning or protocol wrapper tags.`;

const CONTINUATION_INSTRUCTION = `Continue the current task from the existing conversation and tool evidence.
Your previous generation ended without a valid externally consumable action.
Complete exactly one valid next action now:
- If more information or work is required, emit the required tool call.
- If the task is complete, emit the user-visible final answer.
Do not stop with reasoning only.
Do not announce a future tool call without actually emitting it.
Do not emit protocol wrapper examples.`;

const CONTINUATION_INTENT = [
  /^\s*(?:#{1,6}\s*)?(?:plan|next\s+steps?|todo|approach|工作計畫|執行計畫|下一步|計畫)\b/im,
  /^\s*(?:[-*+]|\d+[.)])\s*(?:search|fetch|read|inspect|check|verify|investigate|compare|look\s+up|call|use|搜尋|查詢|查找|讀取|檢查|驗證|比對|調查|呼叫|使用)\b/im,
  /\b(?:i|we)\s+(?:still\s+)?(?:need|should|must|have|want|plan|intend)\s+to\b/i,
  /\b(?:next|continue|continuing)\b/i,
  /\b(?:need|should|must|plan|intend|going)\b.{0,40}\b(?:search|fetch|read|inspect|check|verify|investigate|compare|look\s+up|call|use)\b/i,
  /(?:還需要|仍需|需要先|接下來|下一步|繼續|準備|打算|必須|應該|要再|需再).{0,24}(?:搜尋|查詢|查找|讀取|檢查|驗證|比對|調查|呼叫|使用.{0,8}工具)|(?:尚缺|資料不足|证据不足|資料還不夠)/,
];

function blockBytes(block, key) {
  return typeof block?.[key] === 'string' ? Buffer.byteLength(block[key]) : 0;
}

function responseText(response, type, field) {
  const content = Array.isArray(response?.content) ? response.content : [];
  return content
    .filter((block) => block?.type === type && typeof block?.[field] === 'string')
    .map((block) => block[field].trim())
    .filter(Boolean)
    .join('\n\n');
}

function answerStructureSignals(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const headingCount = lines.filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line)).length;
  const listItemCount = lines.filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)).length;
  const nonEmptyParagraphs = String(text ?? '').split(/\n\s*\n/).filter((part) => part.trim().length >= 20).length;
  return { headingCount, listItemCount, nonEmptyParagraphs };
}

function containsContinuationIntent(text) {
  return CONTINUATION_INTENT.some((pattern) => pattern.test(String(text ?? '')));
}

export function inspectManagedFinalResponse(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const blockTypes = content.map((block) => String(block?.type || 'unknown'));
  const textBlocks = content.filter((block) => block?.type === 'text');
  const thinkingBlocks = content.filter((block) => block?.type === 'thinking');
  const toolUses = content.filter((block) => block?.type === 'tool_use');
  const visibleTextPresent = textBlocks.some((block) => typeof block.text === 'string' && block.text.trim().length > 0);
  const thinkingTextPresent = thinkingBlocks.some((block) => typeof block.thinking === 'string' && block.thinking.trim().length > 0);
  const protocolContent = toolUses.length > 0
    ? content.filter((block) => block?.type !== 'tool_use')
    : content;
  const inventory = inventoryProtocolTags(protocolContent);
  const reasons = [];
  if (inventory.total > 0) reasons.push('control_tag_leak');
  if (toolUses.length === 0 && !visibleTextPresent) reasons.push(thinkingTextPresent ? 'final_answer_in_thinking' : 'missing_visible_text');
  return {
    valid: reasons.length === 0,
    reasons,
    stop_reason: response?.stop_reason ?? null,
    block_types: blockTypes,
    text_block_count: textBlocks.length,
    thinking_block_count: thinkingBlocks.length,
    tool_use_count: toolUses.length,
    text_bytes: textBlocks.reduce((sum, block) => sum + blockBytes(block, 'text'), 0),
    thinking_bytes: thinkingBlocks.reduce((sum, block) => sum + blockBytes(block, 'thinking'), 0),
    visible_text_present: visibleTextPresent,
    thinking_text_present: thinkingTextPresent,
    control_tag_count: inventory.total,
    control_tag_counts: inventory.counts,
  };
}

export function promoteManagedFinalAnswer(response, inspection = inspectManagedFinalResponse(response)) {
  if (response?.stop_reason !== 'end_turn') return null;
  if (inspection.reasons.length !== 1 || inspection.reasons[0] !== 'final_answer_in_thinking') return null;
  if (inspection.tool_use_count !== 0 || !inspection.thinking_text_present || inspection.visible_text_present) return null;
  const content = Array.isArray(response?.content) ? response.content : [];
  if (content.length === 0 || content.some((block) => block?.type !== 'thinking')) return null;

  const recovery = classifyManagedRecovery(response, inspection);
  if (recovery.route !== 'final_channel') return null;
  const candidate = responseText(response, 'thinking', 'thinking').trim();
  if (!candidate) return null;

  return {
    response: { ...structuredClone(response), content: [{ type: 'text', text: candidate }] },
    route: 'deterministic_final_promotion',
    source: 'thinking',
    signals: recovery.signals,
  };
}

export function classifyManagedRecovery(response, inspection = inspectManagedFinalResponse(response)) {
  const thinking = responseText(response, 'thinking', 'thinking');
  const visible = responseText(response, 'text', 'text');
  const candidate = [thinking, visible].filter(Boolean).join('\n\n');
  const structure = answerStructureSignals(candidate);
  const continuationIntent = containsContinuationIntent(candidate);
  const substantial = candidate.length >= 80;
  const structured = structure.listItemCount >= 3
    || (structure.headingCount >= 1 && structure.listItemCount >= 2)
    || structure.nonEmptyParagraphs >= 4;
  const answerLike = inspection.tool_use_count === 0
    && inspection.thinking_text_present
    && substantial
    && structured
    && !continuationIntent;
  const route = answerLike ? 'final_channel' : 'continuation';
  return {
    route,
    tools_preserved: route === 'continuation',
    candidate_text: candidate,
    signals: {
      candidate_chars: candidate.length,
      substantial,
      structured,
      continuation_intent: continuationIntent,
      heading_count: structure.headingCount,
      list_item_count: structure.listItemCount,
      paragraph_count: structure.nonEmptyParagraphs,
    },
  };
}

function appendInstruction(messages, instruction) {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    if (Array.isArray(last.content)) {
      last.content.push({ type: 'text', text: instruction });
      return;
    }
    if (typeof last.content === 'string') {
      last.content = [
        { type: 'text', text: last.content },
        { type: 'text', text: instruction },
      ];
      return;
    }
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: instruction }] });
}

export function buildManagedContinuationRecoveryRequest(request, response, preparedState = null) {
  const recovery = structuredClone(request);
  recovery.stream = false;
  recovery.chat_template_kwargs = {
    ...(recovery.chat_template_kwargs && typeof recovery.chat_template_kwargs === 'object'
      ? recovery.chat_template_kwargs
      : {}),
    enable_thinking: false,
    preserve_thinking: false,
  };
  recovery.messages = Array.isArray(recovery.messages) ? recovery.messages : [];
  const priorState = typeof preparedState?.text === 'string'
    ? preparedState.text.trim()
    : neutralizeControlTags([
      responseText(response, 'thinking', 'thinking'),
      responseText(response, 'text', 'text'),
    ].filter(Boolean).join('\n\n')).trim();
  const instruction = priorState
    ? `Prior model working state (non-authoritative; original conversation and tool evidence remain authoritative):\n${priorState}\n\n${CONTINUATION_INSTRUCTION}`
    : CONTINUATION_INSTRUCTION;
  appendInstruction(recovery.messages, instruction);
  return recovery;
}

export function buildManagedFinalChannelRecoveryRequest(request, response) {
  const recovery = structuredClone(request);
  recovery.stream = false;
  delete recovery.tools;
  delete recovery.tool_choice;
  recovery.system = FINAL_CHANNEL_SYSTEM;
  recovery.chat_template_kwargs = {
    ...(recovery.chat_template_kwargs && typeof recovery.chat_template_kwargs === 'object'
      ? recovery.chat_template_kwargs
      : {}),
    enable_thinking: false,
    preserve_thinking: false,
  };
  const candidate = [
    responseText(response, 'thinking', 'thinking'),
    responseText(response, 'text', 'text'),
  ].filter(Boolean).join('\n\n');
  recovery.messages = [{
    role: 'user',
    content: [{
      type: 'text',
      text: `Move the following malformed response into the visible answer channel.\n\n${neutralizeControlTags(candidate)}`,
    }],
  }];
  return recovery;
}

// Compatibility export retained for callers outside the managed loop.
export function buildManagedFinalRepairRequest(request, response) {
  if (response) return buildManagedFinalChannelRecoveryRequest(request, response);
  const recovery = structuredClone(request);
  recovery.stream = false;
  delete recovery.tools;
  delete recovery.tool_choice;
  recovery.chat_template_kwargs = {
    ...(recovery.chat_template_kwargs && typeof recovery.chat_template_kwargs === 'object'
      ? recovery.chat_template_kwargs
      : {}),
    enable_thinking: false,
    preserve_thinking: false,
  };
  recovery.messages = Array.isArray(recovery.messages) ? recovery.messages : [];
  appendInstruction(recovery.messages, FINAL_CHANNEL_SYSTEM);
  return recovery;
}
