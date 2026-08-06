import { inventoryProtocolTags } from './protocol-sanitizer.js';

const REPAIR_INSTRUCTION = `Return only the final user-visible answer now.
Do not call tools.
Do not emit tool, function, result, reasoning, or message wrapper tags.
Keep private reasoning out of visible text and close the model's native reasoning channel before the final answer.`;

function blockBytes(block, key) {
  return typeof block?.[key] === 'string' ? Buffer.byteLength(block[key]) : 0;
}

export function inspectManagedFinalResponse(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  const blockTypes = content.map((block) => String(block?.type || 'unknown'));
  const textBlocks = content.filter((block) => block?.type === 'text');
  const thinkingBlocks = content.filter((block) => block?.type === 'thinking');
  const toolUses = content.filter((block) => block?.type === 'tool_use');
  const visibleTextPresent = textBlocks.some((block) => typeof block.text === 'string' && block.text.trim().length > 0);
  const thinkingTextPresent = thinkingBlocks.some((block) => typeof block.thinking === 'string' && block.thinking.trim().length > 0);
  const inventory = inventoryProtocolTags(content);
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
    control_tag_count: inventory.total,
    control_tag_counts: inventory.counts,
  };
}

export function buildManagedFinalRepairRequest(request) {
  const repair = structuredClone(request);
  repair.stream = false;
  delete repair.tools;
  delete repair.tool_choice;
  repair.messages = Array.isArray(repair.messages) ? repair.messages : [];
  const last = repair.messages.at(-1);
  if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: REPAIR_INSTRUCTION });
  } else {
    repair.messages.push({ role: 'user', content: [{ type: 'text', text: REPAIR_INSTRUCTION }] });
  }
  return repair;
}
