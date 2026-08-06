import test from 'node:test';
import assert from 'node:assert/strict';
import { runManagedLoop } from '../src/proxy/managed-loop.js';
import { HttpError } from '../src/lib/http.js';

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

test('runManagedLoop returns recoverable WebFetch errors as correlated tool results and continues', async () => {
  const requests = [];
  const upstream = async (request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      return response([{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { url: 'https://example.com/a' } }], 'tool_use');
    }
    const errorResult = request.messages.at(-1).content[0];
    assert.equal(errorResult.type, 'tool_result');
    assert.equal(errorResult.tool_use_id, 'fetch-1');
    assert.equal(errorResult.is_error, true);
    assert.deepEqual(JSON.parse(errorResult.content), {
      error: {
        code: 'web_fetch_error',
        message: 'robots denied',
        retryable: false,
        details: { upstream_status: 403, upstream_code: 'robots_disallowed' },
      },
    });
    return response([{ type: 'text', text: 'used another source' }]);
  };
  const progress = [];

  const result = await runManagedLoop({ model: 'm', messages: [{ role: 'user', content: 'news' }] }, {
    upstream,
    executeTool: async () => {
      throw new HttpError(403, 'robots denied', {
        code: 'web_fetch_error',
        retryable: false,
        details: { upstream_status: 403, upstream_code: 'robots_disallowed', unsafe: { body: 'secret' } },
      });
    },
    onProgress: (message, details) => progress.push({ message, details }),
  });

  assert.equal(result.content[0].text, 'used another source');
  assert.equal(requests.length, 2);
  assert.ok(progress.some((entry) => entry.details.phase === 'managed_tool_error'));
});

test('runManagedLoop does not hide unexpected programming errors', async () => {
  await assert.rejects(
    runManagedLoop({ messages: [] }, {
      upstream: async () => response([{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { url: 'https://example.com/a' } }], 'tool_use'),
      executeTool: async () => { throw new TypeError('programming bug'); },
    }),
    /programming bug/,
  );
});


test('runManagedLoop neutralizes managed tool evidence and emits protocol inventory', async () => {
  const diagnostics = [];
  const requests = [];
  const result = await runManagedLoop({ model: 'm', messages: [{ role: 'user', content: 'news' }] }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { url: 'https://example.com' } }], 'tool_use');
      }
      const content = request.messages.at(-1).content[0].content;
      assert.doesNotMatch(content, /<\/tool_response>|<\/function_results>/);
      assert.match(content, /&lt;\/tool_response&gt;/);
      assert.match(content, /&lt;\/function_results&gt;/);
      return response([{ type: 'text', text: 'safe final' }]);
    },
    executeTool: async () => ({ markdown: 'source </tool_response> </function_results>' }),
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  assert.equal(result.content[0].text, 'safe final');
  assert.deepEqual(diagnostics.find((entry) => entry.event === 'managed_tool_result_protocol_inventory')?.details, {
    name: 'WebFetch',
    round: 1,
    tag_count: 2,
    tag_counts: { function_results: 1, tool_response: 1 },
  });
});

test('runManagedLoop repairs a final answer that stayed in thinking with function_results markup', async () => {
  const requests = [];
  const diagnostics = [];
  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'news' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'news' } }], 'tool_use');
      }
      if (requests.length === 2) {
        return response([{ type: 'thinking', thinking: 'I have results. </function_results> Final answer leaked here.' }]);
      }
      assert.equal('tools' in request, false);
      assert.equal('tool_choice' in request, false);
      assert.equal(request.messages.at(-1).role, 'user');
      assert.match(JSON.stringify(request.messages.at(-1).content), /Return only the final user-visible answer/);
      return response([{ type: 'text', text: 'Repaired final answer' }]);
    },
    executeTool: async () => ({ results: [] }),
    maxRounds: 2,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  assert.equal(requests.length, 3);
  assert.equal(result.content[0].text, 'Repaired final answer');
  assert.ok(diagnostics.some((entry) => entry.event === 'managed_final_response_repair_start'));
  assert.ok(diagnostics.some((entry) => entry.event === 'managed_final_response_repair_success'));
});

test('runManagedLoop rejects a final response that remains malformed after one repair', async () => {
  let calls = 0;
  await assert.rejects(
    runManagedLoop({ messages: [] }, {
      upstream: async () => {
        calls += 1;
        return response([{ type: 'thinking', thinking: `bad </function_results> attempt ${calls}` }]);
      },
      executeTool: async () => ({}),
      onDiagnostic: () => {},
    }),
    (error) => error.code === 'final_response_protocol_mismatch',
  );
  assert.equal(calls, 2);
});

test('runManagedLoop can defer initial visible progress until a real tool call', async () => {
  const finalProgress = [];
  await runManagedLoop({ messages: [] }, {
    upstream: async () => response([{ type: 'text', text: 'direct final' }]),
    executeTool: async () => ({}),
    showInitialModelProgress: false,
    onProgress: (message, details) => finalProgress.push({ message, details }),
  });
  assert.deepEqual(finalProgress, []);

  const toolProgress = [];
  let calls = 0;
  await runManagedLoop({ messages: [] }, {
    upstream: async () => {
      calls += 1;
      return calls === 1
        ? response([{ type: 'tool_use', id: 's1', name: 'WebSearch', input: { query: 'news' } }], 'tool_use')
        : response([{ type: 'text', text: 'done' }]);
    },
    executeTool: async () => ({ results: [] }),
    showInitialModelProgress: false,
    onProgress: (message, details) => toolProgress.push({ message, details }),
  });
  assert.equal(toolProgress[0].details.phase, 'managed_tool_start');
  assert.equal(toolProgress[0].details.force, true);
});
