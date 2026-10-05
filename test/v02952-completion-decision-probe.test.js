import test from 'node:test';
import assert from 'node:assert/strict';
import { runManagedLoop } from '../src/proxy/managed-loop.js';

function response(content, stopReason = 'end_turn') {
  return { id: 'msg', type: 'message', role: 'assistant', model: 'mock', content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } };
}

function decisionTool(decision, remainingWork = '') {
  return response([{ type: 'tool_use', id: `decision-${decision}`, name: 'SubmitCompletionDecision', input: {
    decision,
    ...(remainingWork ? { remaining_work: remainingWork } : {}),
  } }], 'tool_use');
}

test('V0.29.52 completion probe is decision-only and cannot access execution tools', async () => {
  const requests = [];
  const candidate = response([
    { type: 'thinking', thinking: 'The question has been answered.' },
    { type: 'text', text: 'Candidate A.' },
  ], 'end_turn');

  const result = await runManagedLoop({
    model: 'm',
    tools: [
      { name: 'Bash', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'WebSearch', input_schema: { type: 'object' } },
    ],
    messages: [{ role: 'user', content: 'What does this setting mean?' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) return structuredClone(candidate);
      assert.deepEqual(request.tools.map((tool) => tool.name), ['SubmitCompletionDecision']);
      assert.deepEqual(request.tool_choice, {
        type: 'tool', name: 'SubmitCompletionDecision', disable_parallel_tool_use: true,
      });
      assert.equal(request.messages.at(-2).role, 'assistant');
      assert.deepEqual(request.messages.at(-2).content, candidate.content);
      assert.match(JSON.stringify(request.messages.at(-1).content), /Do not perform any work/);
      assert.match(JSON.stringify(request.messages.at(-1).content), /Could do more is not unfinished work/);
      return decisionTool('complete');
    },
    executeTool: async () => assert.fail('decision probe must never execute a tool'),
    completionProbeEnabled: true,
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(result.content, candidate.content);
});

test('V0.29.52 await_user is a valid stopping point and returns the original candidate', async () => {
  const candidate = response([{ type: 'text', text: 'This changes the public API. Do you want option A or B?' }], 'end_turn');
  let calls = 0;
  const diagnostics = [];
  const result = await runManagedLoop({
    model: 'm', tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Change it, but ask me first if the API must change.' }],
  }, {
    upstream: async () => {
      calls += 1;
      return calls === 1 ? structuredClone(candidate) : decisionTool('await_user');
    },
    executeTool: async () => assert.fail('await_user probe must not execute tools'),
    completionProbeEnabled: true,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.content, candidate.content);
  assert.ok(diagnostics.some((entry) => entry.event === 'completion_probe_confirmed_final' && entry.details.decision === 'await_user'));
});

test('V0.29.52 continue decision starts a normal hidden Main continuation with original tools', async () => {
  const requests = [];
  const diagnostics = [];
  const originalTools = [
    { name: 'Bash', description: 'run shell', input_schema: { type: 'object' } },
    { name: 'Read', description: 'read file', input_schema: { type: 'object' } },
  ];
  const candidateA = response([{ type: 'text', text: 'I found the issue and will modify the file next.' }], 'end_turn');
  const finalB = response([{ type: 'text', text: 'The requested change is implemented and verified.' }], 'end_turn');

  const result = await runManagedLoop({
    model: 'm', tools: originalTools,
    messages: [{ role: 'user', content: 'Fix the bug and run the tests.' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) return structuredClone(candidateA);
      if (requests.length === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ['SubmitCompletionDecision']);
        return decisionTool('continue', 'Implement the requested fix and run the tests.');
      }
      if (requests.length === 3) {
        assert.deepEqual(request.tools, originalTools);
        const serialized = JSON.stringify(request.messages);
        assert.match(serialized, /I found the issue and will modify the file next/);
        assert.match(serialized, /Continue only the unfinished work required by the original request/);
        assert.doesNotMatch(serialized, /SubmitCompletionDecision/);
        assert.doesNotMatch(serialized, /Implement the requested fix and run the tests/);
        return structuredClone(finalB);
      }
      assert.fail('one-shot continuation must accept the next no-tool end_turn without another probe');
    },
    executeTool: async () => assert.fail('this fixture does not require executing client tools'),
    completionProbeEnabled: true,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(requests.length, 3);
  assert.deepEqual(result.content, finalB.content);
  assert.doesNotMatch(JSON.stringify(result), /I found the issue and will modify the file next/);
  assert.ok(diagnostics.some((entry) => entry.event === 'completion_probe_continuation' && entry.details.decision === 'continue'));
});

test('V0.29.52 completion probe rejects free text instead of treating no tool use as complete', async () => {
  let calls = 0;
  const diagnostics = [];
  await assert.rejects(runManagedLoop({ model: 'm', messages: [{ role: 'user', content: 'answer this question' }] }, {
    upstream: async () => {
      calls += 1;
      if (calls === 1) return response([{ type: 'text', text: 'Candidate A.' }], 'end_turn');
      return response([{ type: 'text', text: 'Looks complete to me.' }], 'end_turn');
    },
    executeTool: async () => ({}),
    completionProbeEnabled: true,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  }), (error) => error.code === 'completion_probe_invalid');

  assert.equal(calls, 2);
  assert.ok(diagnostics.some((entry) => entry.event === 'completion_probe_failed' && entry.details.code === 'completion_probe_invalid'));
});
