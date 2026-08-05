import test from 'node:test';
import assert from 'node:assert/strict';
import { runManagedLoop } from '../src/proxy/managed-loop.js';

function response(content, stopReason = 'end_turn') {
  return { id: 'msg', type: 'message', role: 'assistant', model: 'mock', content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } };
}

test('runManagedLoop executes correlated managed tool results then continues', async () => {
  const requests = [];
  const upstream = async (request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      return response([{ type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: { query: 'abc' } }], 'tool_use');
    }
    const last = request.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.equal(last.content[0].tool_use_id, 'tool-1');
    return response([{ type: 'text', text: 'final answer' }]);
  };
  const progress = [];
  const result = await runManagedLoop({ model: 'm', messages: [{ role: 'user', content: 'go' }] }, {
    upstream,
    executeTool: async () => ({ results: [{ title: 'x' }] }),
    maxRounds: 6,
    onProgress: (message) => progress.push(message),
  });
  assert.equal(result.content[0].text, 'final answer');
  assert.equal(requests.length, 2);
  assert.match(progress.join('\n'), /搜尋/);
});

test('runManagedLoop returns mixed managed and unmanaged tool calls unchanged', async () => {
  const mixed = response([
    { type: 'tool_use', id: 'a', name: 'WebSearch', input: { query: 'abc' } },
    { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x' } },
  ], 'tool_use');
  let executeCount = 0;
  const result = await runManagedLoop({ messages: [] }, {
    upstream: async () => mixed,
    executeTool: async () => { executeCount += 1; },
    maxRounds: 6,
  });
  assert.deepEqual(result, mixed);
  assert.equal(executeCount, 0);
});

test('runManagedLoop rejects an unbounded managed-tool loop', async () => {
  let sequence = 0;
  await assert.rejects(
    runManagedLoop({ messages: [] }, {
      upstream: async () => response([{ type: 'tool_use', id: `t${sequence++}`, name: 'WebSearch', input: { query: 'loop' } }], 'tool_use'),
      executeTool: async () => ({ results: [] }),
      maxRounds: 2,
    }),
    /maximum managed tool rounds/,
  );
});
