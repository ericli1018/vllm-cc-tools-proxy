import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClaudeCodeCompactRequest,
  prepareClaudeCodeCompactRequest,
} from '../src/proxy/context-compact-detector.js';

const FULL_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const PREFIX_COMPACT_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Please preserve the information required to continue the work.`;

test('V0.2.28.9 detects Claude Code full compact even when WebSearch/WebFetch definitions are present', () => {
  const request = {
    model: 'claude-sonnet-4-6',
    stream: true,
    tools: [{ name: 'WebSearch' }, { name: 'WebFetch' }, { name: 'Read' }],
    messages: [{ role: 'user', content: FULL_COMPACT_PROMPT }],
  };
  assert.deepEqual(classifyClaudeCodeCompactRequest(request), {
    compact: true,
    family: 'full',
    anchor: 'conversation_so_far',
  });
});

test('V0.2.28.9 detects continuing-session compact variant', () => {
  const request = {
    messages: [{ role: 'user', content: [{ type: 'text', text: PREFIX_COMPACT_PROMPT }] }],
  };
  assert.deepEqual(classifyClaudeCodeCompactRequest(request), {
    compact: true,
    family: 'prefix',
    anchor: 'continuing_session',
  });
});

test('V0.2.28.9 does not classify ordinary summarization requests as Claude Code compact', () => {
  assert.deepEqual(classifyClaudeCodeCompactRequest({
    messages: [{ role: 'user', content: 'Please summarize the bug report and then search the web.' }],
    tools: [{ name: 'WebSearch' }],
  }), { compact: false, family: null, anchor: null });
});

test('V0.2.28.9 prepares compact request without active tools while preserving model, stream and messages', () => {
  const request = {
    model: 'claude-sonnet-4-6',
    stream: true,
    tool_choice: { type: 'auto' },
    tools: [{ name: 'WebSearch' }, { name: 'Read' }],
    messages: [{ role: 'user', content: FULL_COMPACT_PROMPT }],
    metadata: { user_id: 'session' },
  };
  const prepared = prepareClaudeCodeCompactRequest(request);
  assert.equal(prepared.model, 'claude-sonnet-4-6');
  assert.equal(prepared.stream, true);
  assert.deepEqual(prepared.messages, request.messages);
  assert.deepEqual(prepared.metadata, request.metadata);
  assert.equal('tools' in prepared, false);
  assert.equal('tool_choice' in prepared, false);
  assert.notEqual(prepared, request);
});

test('V0.2.28.9 detects recent-portion compact variant', () => {
  const request = {
    messages: [{
      role: 'user',
      content: `Your task is to create a detailed summary of the RECENT portion of the conversation. This summary will be used as context when continuing the conversation. Before providing your final summary, preserve the most recent work precisely.`,
    }],
  };
  assert.deepEqual(classifyClaudeCodeCompactRequest(request), {
    compact: true,
    family: 'recent',
    anchor: 'recent_conversation',
  });
});

test('V0.2.28.9 only fingerprints the latest user message so historical compact text cannot hijack a later agent turn', () => {
  const request = {
    messages: [
      { role: 'user', content: FULL_COMPACT_PROMPT },
      { role: 'assistant', content: '<summary>old compact result</summary>' },
      { role: 'user', content: 'Now continue implementation and use WebSearch if needed.' },
    ],
    tools: [{ name: 'WebSearch' }],
  };
  assert.deepEqual(classifyClaudeCodeCompactRequest(request), {
    compact: false,
    family: null,
    anchor: null,
  });
});
