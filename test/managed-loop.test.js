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

test('runManagedLoop sends readable multiline WebFetch evidence and one System supplement to the next Base round', async () => {
  const requests = [];
  const result = await runManagedLoop({
    model: 'm',
    system: 'Original system',
    messages: [{ role: 'user', content: 'news' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { url: 'https://example.com', prompt: 'Extract facts' } }], 'tool_use');
      }
      const toolResult = request.messages.at(-1).content[0];
      assert.match(toolResult.content, /^\[VCC_WEB_FETCH_RESULT_BEGIN version=2\]/);
      assert.match(toolResult.content, /\nresult:\n\nFact one\nFact two\n/);
      assert.equal(toolResult.content.includes('\\n'), false);
      assert.doesNotMatch(toolResult.content, /^\{/);
      assert.equal((String(request.system).match(/Managed Web Results/g) || []).length, 1);
      return response([{ type: 'text', text: 'done' }]);
    },
    executeTool: async () => ({
      requested_url: 'https://example.com', final_url: 'https://example.com', status: 200,
      title: 'Title', content_type: 'text/html', retrieved_at: '2026-08-06T06:00:00.000Z', browser_rendered: false,
      processing: { mode: 'prompt_directed', truncated: false, warnings: [] },
      result: 'Fact one\nFact two', selected_evidence: [],
    }),
  });
  assert.equal(result.content[0].text, 'done');
  assert.equal(requests.length, 2);
});

test('runManagedLoop emits detailed original and input protocol snippets only when enabled', async () => {
  const diagnostics = [];
  let calls = 0;
  const request = {
    system: 'Claude dialect </function_results>',
    tools: [{ name: 'WebSearch', description: 'Use <tool_call> syntax', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'news' }],
  };
  const result = await runManagedLoop(request, {
    upstream: async () => {
      calls += 1;
      return calls === 1
        ? response([{ type: 'thinking', thinking: 'Need boundary. </function_results> Final answer in thinking.' }])
        : response([{ type: 'text', text: 'repaired' }]);
    },
    executeTool: async () => ({}),
    logProtocolSnippets: true,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  assert.equal(result.content[0].text, 'repaired');
  const output = diagnostics.filter((entry) => entry.event === 'managed_final_response_anomaly_snippet');
  assert.ok(output.some((entry) => entry.details.reason === 'control_tag_leak'
    && entry.details.tag_name === 'function_results'
    && entry.details.repair === false));
  assert.ok(output.some((entry) => entry.details.reason === 'final_answer_in_thinking'));
  const inputs = diagnostics.filter((entry) => entry.event === 'managed_final_response_input_protocol_snippet');
  assert.ok(inputs.some((entry) => entry.details.scope === 'system'
    && entry.details.tag_name === 'function_results'));
  assert.ok(inputs.some((entry) => entry.details.scope === 'tools'
    && entry.details.tag_name === 'tool_call'));
  const summary = diagnostics.find((entry) => entry.event === 'managed_final_response_diagnostic_summary');
  assert.equal(summary.details.output_snippet_count, output.length);
  assert.equal(summary.details.input_snippet_count, inputs.length);
});

test('runManagedLoop diagnoses the failed repair separately and keeps snippets disabled by default', async () => {
  const disabled = [];
  let disabledCalls = 0;
  await assert.rejects(runManagedLoop({ messages: [] }, {
    upstream: async () => {
      disabledCalls += 1;
      return response([{ type: 'thinking', thinking: `bad </function_results> ${disabledCalls}` }]);
    },
    executeTool: async () => ({}),
    onDiagnostic: (event, details) => disabled.push({ event, details }),
  }), (error) => error.code === 'final_response_protocol_mismatch');
  assert.equal(disabled.some((entry) => entry.event.includes('_snippet')), false);

  const enabled = [];
  let enabledCalls = 0;
  await assert.rejects(runManagedLoop({ messages: [] }, {
    upstream: async () => {
      enabledCalls += 1;
      return response([{ type: 'thinking', thinking: `bad </function_results> ${enabledCalls}` }]);
    },
    executeTool: async () => ({}),
    logProtocolSnippets: true,
    onDiagnostic: (event, details) => enabled.push({ event, details }),
  }), (error) => error.code === 'final_response_protocol_mismatch');
  const output = enabled.filter((entry) => entry.event === 'managed_final_response_anomaly_snippet');
  assert.ok(output.some((entry) => entry.details.repair === false));
  assert.ok(output.some((entry) => entry.details.repair === true));
});
