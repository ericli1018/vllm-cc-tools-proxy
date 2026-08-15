import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeClaudeAgentRequest,
  describeClaudeAgentHandoff,
} from '../src/proxy/claude-agent-diagnostics.js';

test('V0.29.16 safely fingerprints Claude Code parent/sub-agent request metadata', () => {
  const result = describeClaudeAgentRequest({
    'x-claude-code-agent-id': 'agent-secret-id-123',
    'x-claude-code-parent-agent-id': 'parent-secret-id-456',
    authorization: 'Bearer do-not-log-me',
  }, {
    model: 'claude-sonnet-4-6',
    stream: true,
    tools: [
      { name: 'Read', description: 'read' },
      { name: 'Agent', description: 'delegate' },
      { name: 'Task', description: 'legacy delegate' },
    ],
    messages: [{ role: 'user', content: 'sensitive prompt content' }],
  });

  assert.equal(result.context, 'subagent');
  assert.equal(result.has_agent_id, true);
  assert.equal(result.has_parent_agent_id, true);
  assert.match(result.agent_id_fingerprint, /^[a-f0-9]{12}$/);
  assert.match(result.parent_agent_id_fingerprint, /^[a-f0-9]{12}$/);
  assert.deepEqual(result.declared_subagent_tools, ['Agent', 'Task']);
  assert.equal(result.stream, true);
  assert.equal(result.message_count, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /agent-secret-id-123|parent-secret-id-456|do-not-log-me|sensitive prompt content/);
});

test('V0.29.16 identifies main requests without inventing agent identifiers', () => {
  const result = describeClaudeAgentRequest({}, {
    stream: true,
    tools: [{ name: 'Agent' }],
    messages: [],
  });
  assert.equal(result.context, 'main');
  assert.equal(result.has_agent_id, false);
  assert.equal(result.has_parent_agent_id, false);
  assert.equal(result.agent_id_fingerprint, '');
  assert.equal(result.parent_agent_id_fingerprint, '');
  assert.deepEqual(result.declared_subagent_tools, ['Agent']);
});

test('V0.29.16 summarizes Agent and Task handoffs without logging literal descriptions or prompts', () => {
  const response = {
    content: [
      { type: 'text', text: 'internal visible text' },
      { type: 'tool_use', id: 'toolu-agent-1', name: 'Agent', input: { description: 'Analyze memory lifecycle', prompt: 'top secret agent prompt' } },
      { type: 'tool_use', id: 'toolu-task-2', name: 'Task', input: { description: 'Check PDF pipeline', prompt: 'another secret prompt' } },
      { type: 'tool_use', id: 'toolu-bash-3', name: 'Bash', input: { command: 'secret command' } },
    ],
  };

  const result = describeClaudeAgentHandoff(response);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((entry) => [entry.block_index, entry.tool_name]), [[1, 'Agent'], [2, 'Task']]);
  assert.equal(result[0].description_chars, 'Analyze memory lifecycle'.length);
  assert.match(result[0].description_fingerprint, /^[a-f0-9]{12}$/);
  assert.match(result[0].tool_use_id_fingerprint, /^[a-f0-9]{12}$/);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Analyze memory lifecycle|Check PDF pipeline|top secret|another secret|secret command|toolu-agent-1/);
});
