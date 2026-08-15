import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentDisplayRegistry } from '../src/proxy/subagent-display-registry.js';

test('V0.29.17 binds an Agent description to the child agent id by exact prompt and reuses it for continuations', () => {
  const registry = new SubagentDisplayRegistry({ ttlMs: 60_000, maxAgents: 8, maxPending: 8 });
  registry.recordHandoffs('session-a', {
    content: [{ type: 'tool_use', id: 'toolu-1', name: 'Agent', input: {
      description: '分析 WebSearch 行為',
      prompt: 'research the exact web search behavior',
      subagent_type: 'Explore',
    } }],
  });

  const first = registry.bindRequest({
    sessionId: 'session-a',
    agentId: 'agent-secret-1',
    request: { messages: [{ role: 'user', content: 'research the exact web search behavior' }] },
  });
  assert.equal(first.title, '分析 WebSearch 行為');
  assert.equal(first.source, 'prompt_match');

  const continuation = registry.bindRequest({
    sessionId: 'session-a',
    agentId: 'agent-secret-1',
    request: { messages: [
      { role: 'user', content: 'research the exact web search behavior' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search-1', content: 'results' }] },
    ] },
  });
  assert.equal(continuation.title, '分析 WebSearch 行為');
  assert.equal(continuation.source, 'agent_id');
});

test('V0.29.17 does not cross-bind parallel Agent prompts within the same session', () => {
  const registry = new SubagentDisplayRegistry({ ttlMs: 60_000, maxAgents: 8, maxPending: 8 });
  registry.recordHandoffs('session-p', { content: [
    { type: 'tool_use', name: 'Agent', input: { description: '工作 A', prompt: 'prompt A' } },
    { type: 'tool_use', name: 'Agent', input: { description: '工作 B', prompt: 'prompt B' } },
  ] });

  assert.equal(registry.bindRequest({ sessionId: 'session-p', agentId: 'b', request: { messages: [{ role: 'user', content: 'prompt B' }] } }).title, '工作 B');
  assert.equal(registry.bindRequest({ sessionId: 'session-p', agentId: 'a', request: { messages: [{ role: 'user', content: 'prompt A' }] } }).title, '工作 A');
});

test('V0.29.17 can bind by exact prompt even when Claude Code does not provide a session id', () => {
  const registry = new SubagentDisplayRegistry({ ttlMs: 60_000, maxAgents: 8, maxPending: 8 });
  registry.recordHandoffs('', { content: [{ type: 'tool_use', name: 'Agent', input: { description: '無 Session 工作', prompt: 'prompt without session' } }] });
  const bound = registry.bindRequest({ agentId: 'agent-no-session', request: { messages: [{ role: 'user', content: 'prompt without session' }] } });
  assert.equal(bound.title, '無 Session 工作');
  assert.equal(bound.source, 'prompt_match');
  assert.equal(registry.bindRequest({ agentId: 'agent-no-session', request: { messages: [] } }).source, 'agent_id');
});
