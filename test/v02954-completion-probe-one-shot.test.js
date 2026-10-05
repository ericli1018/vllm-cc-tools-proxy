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

test('V0.29.54 completion probe defaults to complete and only continues explicit transitional commitments', async () => {
  let calls = 0;
  const candidate = response([{ type: 'text', text: 'The setting means X; Y is optional.' }]);

  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'What does this setting mean?' }],
  }, {
    upstream: async (request) => {
      calls += 1;
      if (calls === 1) return structuredClone(candidate);
      const prompt = JSON.stringify(request.messages.at(-1)?.content || []);
      assert.match(prompt, /Default to COMPLETE/i);
      assert.match(prompt, /clearly a transitional response/i);
      assert.match(prompt, /explicitly commits to performing a concrete operation/i);
      assert.match(prompt, /could be improved, expanded, verified further, researched further/i);
      assert.match(prompt, /Could do more is not unfinished work/i);
      return decisionTool('complete');
    },
    executeTool: async () => assert.fail('probe must not execute tools'),
    completionProbeEnabled: true,
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.content, candidate.content);
});

test('V0.29.54 accepts the next no-tool end_turn after one probe continuation without probing again', async () => {
  const requests = [];
  const diagnostics = [];
  const candidateA = response([{ type: 'text', text: 'I will modify the requested file next.' }]);
  const finalB = response([{ type: 'text', text: 'I cannot proceed further without inventing additional work.' }]);

  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Review this and answer the question.' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) return structuredClone(candidateA);
      if (requests.length === 2) return decisionTool('continue', 'Perform the concrete operation explicitly promised in the latest response.');
      if (requests.length === 3) return structuredClone(finalB);
      assert.fail('one-shot continuation must not launch a second completion probe');
    },
    executeTool: async () => assert.fail('Main chose no tool on the one allowed continuation round'),
    completionProbeEnabled: true,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(requests.length, 3);
  assert.deepEqual(result.content, finalB.content);
  assert.equal(diagnostics.filter((entry) => entry.event === 'completion_probe_started').length, 1);
  assert.ok(diagnostics.some((entry) => entry.event === 'completion_probe_continuation_declined'
    && entry.details.reason === 'main_end_turn_without_tool'));
});

test('V0.29.54 suppresses probe continuation when no managed round budget remains', async () => {
  const diagnostics = [];
  let calls = 0;
  const candidate = response([{ type: 'text', text: 'Candidate final at the last available managed round.' }]);

  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Answer this.' }],
  }, {
    upstream: async () => {
      calls += 1;
      if (calls === 1) return structuredClone(candidate);
      if (calls === 2) return decisionTool('continue', 'A concrete required operation remains unfinished.');
      assert.fail('round-budget suppression must not start another Main round');
    },
    executeTool: async () => assert.fail('no tool should run'),
    completionProbeEnabled: true,
    maxRounds: 1,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.content, candidate.content);
  assert.ok(diagnostics.some((entry) => entry.event === 'completion_probe_continuation_suppressed'
    && entry.details.reason === 'round_budget'));
});
