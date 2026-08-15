import crypto from 'node:crypto';

const SUBAGENT_TOOL_NAMES = new Set(['agent', 'task']);

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== target) continue;
    if (Array.isArray(value)) return String(value[0] || '').trim();
    return String(value || '').trim();
  }
  return '';
}

function fingerprint(value) {
  const text = String(value || '');
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function declaredSubagentTools(request) {
  const found = [];
  const seen = new Set();
  for (const tool of Array.isArray(request?.tools) ? request.tools : []) {
    const name = String(tool?.name || '').trim();
    if (!name || !SUBAGENT_TOOL_NAMES.has(name.toLowerCase()) || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}

export function describeClaudeAgentRequest(headers, request = {}) {
  const agentId = headerValue(headers, 'x-claude-code-agent-id');
  const parentAgentId = headerValue(headers, 'x-claude-code-parent-agent-id');
  return {
    context: agentId || parentAgentId ? 'subagent' : 'main',
    has_agent_id: Boolean(agentId),
    has_parent_agent_id: Boolean(parentAgentId),
    agent_id_fingerprint: fingerprint(agentId),
    parent_agent_id_fingerprint: fingerprint(parentAgentId),
    declared_subagent_tools: declaredSubagentTools(request),
    stream: request?.stream === true,
    message_count: Array.isArray(request?.messages) ? request.messages.length : 0,
  };
}

export function describeClaudeAgentHandoff(response = {}) {
  const output = [];
  const content = Array.isArray(response?.content) ? response.content : [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (block?.type !== 'tool_use') continue;
    const toolName = String(block?.name || '').trim();
    if (!SUBAGENT_TOOL_NAMES.has(toolName.toLowerCase())) continue;
    const description = typeof block?.input?.description === 'string' ? block.input.description : '';
    output.push({
      block_index: index,
      tool_name: toolName,
      tool_use_id_fingerprint: fingerprint(block?.id || ''),
      description_chars: description.length,
      description_fingerprint: fingerprint(description),
    });
  }
  return output;
}
