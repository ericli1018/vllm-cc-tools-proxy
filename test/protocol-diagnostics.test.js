import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectRequestProtocolSnippets,
  collectResponseAnomalySnippets,
  redactDiagnosticText,
} from '../src/proxy/protocol-diagnostics.js';

test('response diagnostics report every control tag with exact block path and bounded context', () => {
  const thinking = 'first line\nAuthorization: Bearer super-secret-token\nBefore </function_results> after <tool_response> tail';
  const response = {
    id: 'msg-1', model: 'laguna', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking }],
  };
  const snippets = collectResponseAnomalySnippets(response, {
    reasons: ['control_tag_leak', 'final_answer_in_thinking'],
  });
  const controls = snippets.filter((entry) => entry.reason === 'control_tag_leak');
  assert.equal(controls.length, 2);
  assert.deepEqual(controls.map((entry) => entry.tag_name), ['function_results', 'tool_response']);
  assert.equal(controls[0].block_index, 0);
  assert.equal(controls[0].block_type, 'thinking');
  assert.equal(controls[0].field, 'thinking');
  assert.equal(controls[0].line, 3);
  assert.equal(controls[0].column, 8);
  assert.equal(controls[0].tag_raw, '</function_results>');
  assert.match(controls[0].context_before, /Before $/);
  assert.match(controls[0].context_after, /^ after/);
  assert.match(controls[0].snippet, /Before <\/function_results> after/);
  assert.equal(controls[0].content_sha256.length, 64);
  assert.equal(JSON.stringify(snippets).includes('super-secret-token'), false);
  assert.match(JSON.stringify(snippets), /\[REDACTED\]/);
});

test('thinking-only diagnostics include bounded head and tail excerpts without requiring a tag', () => {
  const text = `${'HEAD '.repeat(180)}middle${' TAIL'.repeat(180)}`;
  const snippets = collectResponseAnomalySnippets({
    content: [{ type: 'thinking', thinking: text }],
  }, { reasons: ['final_answer_in_thinking'] });
  const entry = snippets.find((item) => item.reason === 'final_answer_in_thinking');
  assert.ok(entry);
  assert.match(entry.excerpt_head, /^HEAD/);
  assert.match(entry.excerpt_tail, /TAIL$/);
  assert.ok(entry.omitted_chars > 0);
  assert.equal(entry.content_chars, text.length);
});

test('request diagnostics locate protocol priming in system messages and tool definitions', () => {
  const snippets = collectRequestProtocolSnippets({
    system: 'System dialect </function_results>',
    messages: [
      { role: 'user', content: 'plain' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'History <tool_response> data' }] },
    ],
    tools: [{ name: 'X', description: 'Example <tool_call> wrapper' }],
  });
  assert.equal(snippets.length, 3);
  assert.deepEqual(snippets.map((entry) => entry.scope), ['system', 'messages', 'tools']);
  assert.equal(snippets[1].message_index, 1);
  assert.equal(snippets[1].role, 'assistant');
  assert.equal(snippets[1].path, 'messages[1].content[0].thinking');
  assert.ok(snippets.every((entry) => entry.reason === 'input_protocol_tag'));
  assert.deepEqual(snippets.map((entry) => entry.tag_name), ['function_results', 'tool_response', 'tool_call']);
});


test('response diagnostics mirror recursive guard scanning for tags in unknown block fields', () => {
  const response = {
    content: [{
      type: 'custom',
      payload: { note: 'nested before <function_call> nested after' },
    }],
  };
  const snippets = collectResponseAnomalySnippets(response, { reasons: ['control_tag_leak'] });
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].block_index, 0);
  assert.equal(snippets[0].block_type, 'custom');
  assert.equal(snippets[0].field, 'payload');
  assert.equal(snippets[0].path, 'content[0].payload.note');
  assert.equal(snippets[0].tag_name, 'function_call');
  assert.match(snippets[0].snippet, /nested before <function_call> nested after/);
});

test('diagnostic redaction removes common credentials while preserving surrounding evidence', () => {
  const input = 'api_key=sk-abcdefghijklmnop password: hunter2 https://alice:secret@example.com Bearer abc.def.ghi {\"auth_token\":\"json-secret\",\"password\":\"json-password\"}';
  const output = redactDiagnosticText(input);
  assert.doesNotMatch(output, /abcdefghijklmnop|hunter2|alice:secret|abc\.def\.ghi|json-secret|json-password/);
  assert.match(output, /api_key=\[REDACTED\]/);
  assert.match(output, /password: \[REDACTED\]/);
  assert.match(output, /https:\/\/\[REDACTED\]@example\.com/);
  assert.match(output, /Bearer \[REDACTED\]/);
});

test('full diagnostic fields are opt-in and fully redacted before persistence', () => {
  const response = {
    content: [{
      type: 'thinking',
      thinking: 'Authorization: Bearer top-secret\nComplete final answer inside thinking.',
    }],
  };
  const bounded = collectResponseAnomalySnippets(response, { reasons: ['final_answer_in_thinking'] });
  assert.equal('full_text_redacted' in bounded[0], false);

  const complete = collectResponseAnomalySnippets(
    response,
    { reasons: ['final_answer_in_thinking'] },
    { includeFullText: true },
  );
  assert.match(complete[0].full_text_redacted, /Complete final answer inside thinking\.$/);
  assert.doesNotMatch(complete[0].full_text_redacted, /top-secret/);
  assert.match(complete[0].full_text_redacted, /Bearer \[REDACTED\]/);

  const request = collectRequestProtocolSnippets({
    tools: [{ description: 'password=hidden Example <thinking>full tool description</thinking>' }],
  }, { includeFullText: true });
  assert.equal(request.length, 2);
  assert.ok(request.every((entry) => entry.full_text_redacted.includes('full tool description')));
  assert.ok(request.every((entry) => !entry.full_text_redacted.includes('hidden')));
});
