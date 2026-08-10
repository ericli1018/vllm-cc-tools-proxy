const FULL_OPENING = 'your task is to create a detailed summary of the conversation so far';
const PREFIX_OPENING = 'your task is to create a detailed summary of this conversation';
const RECENT_OPENING = 'your task is to create a detailed summary of the recent portion of the conversation';

function collectText(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (typeof value.text === 'string') output.push(value.text);
  return output;
}

function requestText(request) {
  if (!Array.isArray(request?.messages)) return '';
  const lastUserMessage = [...request.messages].reverse().find((message) => message?.role === 'user');
  if (!lastUserMessage) return '';
  return collectText(lastUserMessage.content).join('\n').toLowerCase();
}

function hasCompactContinuationIntent(text) {
  return [
    'continuing development work without losing context',
    'summary will be used as context when continuing the conversation',
    'summary will be placed at the start of a continuing session',
    'newer messages that build on this context will follow after your summary',
    'please provide your summary based on the conversation so far',
    'before providing your final summary',
  ].some((anchor) => text.includes(anchor));
}

export function classifyClaudeCodeCompactRequest(request) {
  const text = requestText(request);
  if (!text || !hasCompactContinuationIntent(text)) {
    return { compact: false, family: null, anchor: null };
  }

  if (text.includes(RECENT_OPENING)) {
    return { compact: true, family: 'recent', anchor: 'recent_conversation' };
  }
  if (text.includes(FULL_OPENING)) {
    return { compact: true, family: 'full', anchor: 'conversation_so_far' };
  }
  if (text.includes(PREFIX_OPENING)
      && (text.includes('continuing session') || text.includes('newer messages that build on this context'))) {
    return { compact: true, family: 'prefix', anchor: 'continuing_session' };
  }
  return { compact: false, family: null, anchor: null };
}

export function prepareClaudeCodeCompactRequest(request) {
  const prepared = structuredClone(request || {});
  delete prepared.tools;
  delete prepared.tool_choice;
  return prepared;
}
