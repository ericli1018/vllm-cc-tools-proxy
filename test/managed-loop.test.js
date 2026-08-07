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

test('V0.2.20 defers mixed server web tools while preserving Claude Code client tool intent', async () => {
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
  assert.equal(executeCount, 0);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content[0].type, 'server_tool_use');
  assert.match(result.content[0].id, /^srvtoolu_/);
  assert.equal(result.content[0].name, 'web_search');
  assert.deepEqual(result.content[0].input, { query: 'abc' });
  assert.deepEqual(result.content[1], { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x' } });
});

test('V0.2.20 resumes deferred server web tool after Claude Code returns client tool_result', async () => {
  const executions = [];
  const requests = [];
  const pendingId = 'srvtoolu_pending_search';
  const initial = {
    model: 'm',
    tools: [
      { name: 'web_search', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: 'search and read' },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: pendingId, name: 'web_search', input: { query: 'tls docs' } },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/project/a.c' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'read-1', content: 'int main(void){}' },
      ] },
    ],
  };
  const serverEvents = [];
  const result = await runManagedLoop(initial, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      const assistant = request.messages.at(-2);
      const user = request.messages.at(-1);
      assert.equal(assistant.content[0].type, 'tool_use');
      assert.equal(assistant.content[0].id, pendingId);
      assert.equal(assistant.content[0].name, 'web_search');
      assert.equal(user.content.length, 2);
      assert.equal(user.content[1].type, 'tool_result');
      assert.equal(user.content[1].tool_use_id, pendingId);
      return response([{ type: 'text', text: 'continued after both tools' }]);
    },
    executeTool: async (toolUse) => {
      executions.push(structuredClone(toolUse));
      return { query: toolUse.input.query, result_count: 1, results: [{ title: 'Docs', url: 'https://example.com', snippet: 'evidence' }] };
    },
    onServerToolEvent: async (event) => serverEvents.push(structuredClone(event)),
  });
  assert.equal(executions.length, 1);
  assert.equal(executions[0].id, pendingId);
  assert.deepEqual(serverEvents.map((entry) => entry.phase), ['result']);
  assert.equal(serverEvents[0].block.type, 'web_search_tool_result');
  assert.equal(result.content[0].text, 'continued after both tools');
  assert.equal(requests.length, 1);
});



test('V0.2.20 removes completed server web lifecycle blocks from later Base-model history', async () => {
  let observed;
  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'news' },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'srvtoolu_done', name: 'web_search', input: { query: 'today news' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_done', content: [
          { type: 'web_search_result', title: 'News', url: 'https://example.com/news' },
        ] },
        { type: 'text', text: 'Earlier answer.' },
      ] },
      { role: 'user', content: 'What about that source?' },
    ],
  }, {
    upstream: async (request) => {
      observed = structuredClone(request);
      return response([{ type: 'text', text: 'follow-up' }]);
    },
    executeTool: async () => { throw new Error('completed history must not execute again'); },
  });
  assert.equal(result.content[0].text, 'follow-up');
  assert.doesNotMatch(JSON.stringify(observed.messages), /server_tool_use|web_search_tool_result/);
  assert.match(JSON.stringify(observed.messages), /https:\/\/example\.com\/news/);
});

test('runManagedLoop rejects an unbounded managed-tool loop', async () => {
  let sequence = 0;
  await assert.rejects(
    runManagedLoop({ messages: [] }, {
      upstream: async () => response([{ type: 'tool_use', id: `t${sequence}`, name: 'WebSearch', input: { query: `loop-${sequence++}` } }], 'tool_use'),
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
      assert.ok(Array.isArray(request.tools));
      assert.deepEqual(request.tool_choice, { type: 'auto' });
      assert.equal(request.messages.at(-1).role, 'user');
      assert.match(JSON.stringify(request.messages.at(-1).content), /Complete exactly one valid next action/);
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
    (error) => error.code === 'response_recovery_exhausted',
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

test('runManagedLoop writes complete protocol diagnostics to a file callback without logging snippets', async () => {
  const diagnostics = [];
  const files = [];
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
    writeProtocolDiagnostics: async (bundle) => {
      files.push(bundle);
      return {
        file_path: '/tmp/vllm-cc-tools-proxy/protocol-snippets/example.json',
        file_bytes: 1234,
        file_sha256: 'a'.repeat(64),
        created_at: '2026-08-06T07:48:27.545Z',
      };
    },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  assert.equal(result.content[0].text, 'repaired');
  assert.equal(files.length, 1);
  assert.equal(files[0].repair, false);
  assert.ok(files[0].output_snippets.some((entry) => entry.reason === 'control_tag_leak'
    && entry.tag_name === 'function_results'
    && entry.full_text_redacted.includes('Final answer in thinking.')));
  assert.ok(files[0].output_snippets.some((entry) => entry.reason === 'final_answer_in_thinking'));
  assert.ok(files[0].input_snippets.some((entry) => entry.scope === 'system'
    && entry.tag_name === 'function_results'
    && entry.full_text_redacted.includes('Claude dialect')));
  assert.ok(files[0].input_snippets.some((entry) => entry.scope === 'tools'
    && entry.tag_name === 'tool_call'));
  assert.equal(diagnostics.some((entry) => entry.event === 'managed_final_response_anomaly_snippet'), false);
  assert.equal(diagnostics.some((entry) => entry.event === 'managed_final_response_input_protocol_snippet'), false);
  const fileEvent = diagnostics.find((entry) => entry.event === 'managed_final_response_diagnostic_file');
  assert.ok(fileEvent);
  assert.equal(fileEvent.details.file_bytes, 1234);
  assert.equal(fileEvent.details.output_snippet_count, files[0].output_snippets.length);
  assert.equal(fileEvent.details.input_snippet_count, files[0].input_snippets.length);
});

test('runManagedLoop writes original and failed-repair diagnostics separately and stays quiet when disabled', async () => {
  const disabled = [];
  let disabledCalls = 0;
  await assert.rejects(runManagedLoop({ messages: [] }, {
    upstream: async () => {
      disabledCalls += 1;
      return response([{ type: 'thinking', thinking: `bad </function_results> ${disabledCalls}` }]);
    },
    executeTool: async () => ({}),
    onDiagnostic: (event, details) => disabled.push({ event, details }),
  }), (error) => error.code === 'response_recovery_exhausted');
  assert.equal(disabled.some((entry) => entry.event.includes('diagnostic_file')), false);

  const enabled = [];
  const files = [];
  let enabledCalls = 0;
  await assert.rejects(runManagedLoop({ messages: [] }, {
    upstream: async () => {
      enabledCalls += 1;
      return response([{ type: 'thinking', thinking: `bad </function_results> ${enabledCalls}` }]);
    },
    executeTool: async () => ({}),
    logProtocolSnippets: true,
    writeProtocolDiagnostics: async (bundle) => {
      files.push(bundle);
      return {
        file_path: `/tmp/diagnostic-${files.length}.json`,
        file_bytes: 100 + files.length,
        file_sha256: String(files.length).repeat(64),
        created_at: '2026-08-06T07:48:27.545Z',
      };
    },
    onDiagnostic: (event, details) => enabled.push({ event, details }),
  }), (error) => error.code === 'response_recovery_exhausted');
  assert.deepEqual(files.map((entry) => entry.repair), [false, true]);
  assert.equal(enabled.filter((entry) => entry.event === 'managed_final_response_diagnostic_file').length, 2);
  assert.equal(enabled.some((entry) => entry.event.includes('_snippet')), false);
});

test('runManagedLoop continues repair when protocol diagnostic file writing fails', async () => {
  const diagnostics = [];
  let calls = 0;
  const result = await runManagedLoop({ messages: [] }, {
    upstream: async () => {
      calls += 1;
      return calls === 1
        ? response([{ type: 'thinking', thinking: 'answer stayed in thinking' }])
        : response([{ type: 'text', text: 'repaired' }]);
    },
    executeTool: async () => ({}),
    logProtocolSnippets: true,
    writeProtocolDiagnostics: async () => {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  assert.equal(result.content[0].text, 'repaired');
  const failure = diagnostics.find((entry) => entry.event === 'managed_final_response_diagnostic_file_failed');
  assert.ok(failure);
  assert.equal(failure.details.code, 'ENOSPC');
  assert.equal(JSON.stringify(failure).includes('answer stayed in thinking'), false);
});


test('runManagedLoop uses short final-channel recovery only for a structured completed answer in thinking', async () => {
  const requests = [];
  const diagnostics = [];
  const completedAnswer = `# 今日科技新聞摘要

1. 第一則新聞已確認事件、日期與影響。
2. 第二則新聞已交叉比對來源並整理重點。
3. 第三則新聞補充市場反應與後續影響。

整體而言，今日科技焦點集中在人工智慧基礎設施、監管與半導體需求。`;

  const result = await runManagedLoop({
    model: 'm',
    system: 'original system must not be copied into short recovery',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'news' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) return response([{ type: 'thinking', thinking: completedAnswer }], 'max_tokens');
      assert.equal('tools' in request, false);
      assert.equal('tool_choice' in request, false);
      assert.notEqual(request.system, 'original system must not be copied into short recovery');
      assert.equal(request.messages.length, 1);
      assert.match(JSON.stringify(request.messages), /今日科技新聞摘要/);
      assert.match(String(request.system), /Do not add new facts/);
      assert.equal(request.chat_template_kwargs.enable_thinking, false);
      assert.equal(request.chat_template_kwargs.preserve_thinking, false);
      return response([{ type: 'text', text: completedAnswer }]);
    },
    executeTool: async () => assert.fail('final-channel recovery must not execute tools'),
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(result.content[0].text, completedAnswer);
  assert.equal(requests.length, 2);
  const start = diagnostics.find((entry) => entry.event === 'managed_final_response_repair_start');
  assert.equal(start.details.recovery_route, 'final_channel');
  assert.equal(start.details.tools_preserved, false);
});

test('runManagedLoop preserves tools for unfinished thinking and executes a recovered managed tool call', async () => {
  const requests = [];
  const diagnostics = [];
  const toolExecutions = [];

  const result = await runManagedLoop({
    model: 'm',
    tools: [
      { name: 'WebSearch', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
    ],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'research then finish the task' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([{ type: 'thinking', thinking: 'I still need to compare the official source, then search for the release notes.' }]);
      }
      if (requests.length === 2) {
        assert.equal(request.tools.length, 2);
        assert.deepEqual(request.tool_choice, { type: 'auto' });
        assert.match(JSON.stringify(request.messages.at(-1)), /Previous incomplete model state/);
        assert.match(JSON.stringify(request.messages.at(-1)), /I still need to compare/);
        assert.match(JSON.stringify(request.messages.at(-1)), /Complete exactly one valid next action/);
        assert.equal(request.chat_template_kwargs.enable_thinking, false);
        assert.equal(request.chat_template_kwargs.preserve_thinking, false);
        return response([{ type: 'tool_use', id: 'search-recovered', name: 'WebSearch', input: { query: 'official release notes' } }], 'tool_use');
      }
      const last = request.messages.at(-1);
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].tool_use_id, 'search-recovered');
      return response([{ type: 'text', text: 'Research completed.' }]);
    },
    executeTool: async (toolUse) => {
      toolExecutions.push(toolUse);
      return { query: toolUse.input.query, results: [{ title: 'Official', url: 'https://example.com', snippet: 'release' }] };
    },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(result.content[0].text, 'Research completed.');
  assert.equal(toolExecutions.length, 1);
  assert.equal(toolExecutions[0].id, 'search-recovered');
  assert.equal(requests.length, 3);
  const start = diagnostics.find((entry) => entry.event === 'managed_final_response_repair_start');
  assert.equal(start.details.recovery_route, 'continuation');
  assert.equal(start.details.tools_preserved, true);
  assert.ok(diagnostics.some((entry) => entry.event === 'managed_final_response_recovery_tool_dispatch'
    && entry.details.disposition === 'managed'));
});

test('runManagedLoop returns a recovered unmanaged tool call to Claude Code without executing it', async () => {
  let calls = 0;
  let executed = false;
  const result = await runManagedLoop({
    model: 'm',
    tools: [
      { name: 'WebSearch', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
    ],
    messages: [{ role: 'user', content: 'inspect the repository after research' }],
  }, {
    upstream: async (request) => {
      calls += 1;
      if (calls === 1) return response([{ type: 'thinking', thinking: 'The web evidence is enough; next I need to read the local configuration file.' }]);
      assert.ok(Array.isArray(request.tools));
      return response([{ type: 'tool_use', id: 'read-recovered', name: 'Read', input: { file_path: '/workspace/config.json' } }], 'tool_use');
    },
    executeTool: async () => { executed = true; },
  });

  assert.equal(calls, 2);
  assert.equal(executed, false);
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].name, 'Read');
});

test('runManagedLoop rejects a second thinking-only response after one continuation recovery', async () => {
  const requests = [];
  await assert.rejects(runManagedLoop({
    model: 'm',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'research' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      return response([{ type: 'thinking', thinking: `Still deciding the next search ${requests.length}.` }]);
    },
    executeTool: async () => ({}),
  }), (error) => error.code === 'response_recovery_exhausted');
  assert.equal(requests.length, 2);
  assert.ok(Array.isArray(requests[1].tools));
});

test('runManagedLoop treats a structured action plan in thinking as continuation rather than a completed answer', async () => {
  const requests = [];
  let toolExecutions = 0;
  await assert.rejects(runManagedLoop({
    model: 'm',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'complete the research workflow' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([{ type: 'thinking', thinking: `# Plan

1. Search the official documentation.
2. Read the release notes.
3. Compare the documented behavior with the current configuration.` }]);
      }
      assert.ok(Array.isArray(request.tools));
      assert.match(JSON.stringify(request.messages.at(-1)), /Complete exactly one valid next action/);
      return response([{ type: 'tool_use', id: 'planned-search', name: 'WebSearch', input: { query: 'official documentation' } }], 'tool_use');
    },
    executeTool: async () => { toolExecutions += 1; return { results: [] }; },
    maxRounds: 1,
  }), (error) => error.code === 'managed_tool_loop_limit');
  assert.equal(requests.length, 2);
  assert.equal(toolExecutions, 1);
});

test('runManagedLoop accepts protocol-like text inside a recovered managed tool argument', async () => {
  let calls = 0;
  let executedQuery = '';
  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'research a parser issue' }],
  }, {
    upstream: async () => {
      calls += 1;
      if (calls === 1) return response([{ type: 'thinking', thinking: 'I need to search for the exact parser marker behavior.' }]);
      if (calls === 2) {
        return response([{ type: 'tool_use', id: 'marker-search', name: 'WebSearch', input: { query: 'vLLM </function_results> parser behavior' } }], 'tool_use');
      }
      return response([{ type: 'text', text: 'done' }]);
    },
    executeTool: async (toolUse) => { executedQuery = toolUse.input.query; return { results: [] }; },
  });
  assert.equal(result.content[0].text, 'done');
  assert.equal(executedQuery, 'vLLM </function_results> parser behavior');
});


test('runManagedLoop contains response-side native web search and executes it internally', async () => {
  const requests = [];
  const executions = [];
  const diagnostics = [];
  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'research' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([
          { type: 'server_tool_use', id: 'srv-search-1', name: 'web_search', input: { query: 'libuv openssl' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv-search-1', content: [] },
        ], 'pause_turn');
      }
      const assistant = request.messages.at(-2);
      assert.deepEqual(assistant.content, [
        { type: 'tool_use', id: 'srv-search-1', name: 'web_search', input: { query: 'libuv openssl' } },
      ]);
      const toolResult = request.messages.at(-1).content[0];
      assert.equal(toolResult.tool_use_id, 'srv-search-1');
      return response([{ type: 'text', text: 'FINAL AFTER LOCAL SEARCH' }]);
    },
    executeTool: async (toolUse) => {
      executions.push(structuredClone(toolUse));
      return { query: toolUse.input.query, result_count: 1, results: [{ title: 'Docs', url: 'https://example.com', snippet: 'evidence' }] };
    },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(result.content[0].text, 'FINAL AFTER LOCAL SEARCH');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].name, 'web_search');
  assert.ok(diagnostics.some((entry) => entry.event === 'native_web_response_contained'));
  assert.doesNotMatch(JSON.stringify(result.content), /server_tool_use|web_search_tool_result/);
});

test('runManagedLoop contains response-side native web fetch and executes it internally', async () => {
  let calls = 0;
  let executions = 0;
  const result = await runManagedLoop({
    model: 'm', tools: [{ name: 'web_fetch', input_schema: { type: 'object' } }], messages: [],
  }, {
    upstream: async () => {
      calls += 1;
      if (calls === 1) return response([
        { type: 'server_tool_use', id: 'srv-fetch-1', name: 'web_fetch', input: { url: 'https://example.com/a' } },
      ], 'pause_turn');
      return response([{ type: 'text', text: 'FETCH FINAL' }]);
    },
    executeTool: async () => { executions += 1; return { markdown: 'page' }; },
  });
  assert.equal(result.content[0].text, 'FETCH FINAL');
  assert.equal(executions, 1);
});

test('V0.2.20 preserves response-side native web call as deferred server_tool_use beside client tool', async () => {
  let webExecutions = 0;
  const result = await runManagedLoop({
    model: 'm',
    tools: [
      { name: 'web_search', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
    ],
    messages: [{ role: 'user', content: 'research then read' }],
  }, {
    upstream: async () => response([
      { type: 'server_tool_use', id: 'srv-search-mixed', name: 'web_search', input: { query: 'tls docs' } },
      { type: 'tool_use', id: 'read-premature', name: 'Read', input: { file_path: '/project/a.c' } },
    ], 'tool_use'),
    executeTool: async () => { webExecutions += 1; return { results: [] }; },
  });

  assert.equal(webExecutions, 0);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content[0].type, 'server_tool_use');
  assert.equal(result.content[0].name, 'web_search');
  assert.deepEqual(result.content[1], { type: 'tool_use', id: 'read-premature', name: 'Read', input: { file_path: '/project/a.c' } });
});

test('V0.2.19 validates tool-use responses and recovers leaked protocol markup before dispatch', async () => {
  const requests = [];
  const diagnostics = [];
  const executed = [];
  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'research tls' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([
          { type: 'thinking', thinking: 'Need evidence <tool_call>WebSearch<arg_key>query</arg_key><arg_value>bad</arg_value></tool_call>' },
          { type: 'tool_use', id: 'unsafe-original', name: 'WebSearch', input: { query: 'bad' } },
        ], 'tool_use');
      }
      if (requests.length === 2) {
        assert.equal(request.chat_template_kwargs.enable_thinking, false);
        assert.equal(request.chat_template_kwargs.preserve_thinking, false);
        assert.ok(Array.isArray(request.tools));
        assert.match(JSON.stringify(request.messages.at(-1)), /Previous incomplete model state/);
        assert.doesNotMatch(JSON.stringify(request.messages.at(-1)), /<tool_call>|<arg_key>|<arg_value>/);
        return response([{ type: 'tool_use', id: 'safe-recovered', name: 'WebSearch', input: { query: 'good' } }], 'tool_use');
      }
      return response([{ type: 'text', text: 'done' }]);
    },
    executeTool: async (toolUse) => { executed.push(toolUse.id); return { results: [] }; },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(result.content[0].text, 'done');
  assert.deepEqual(executed, ['safe-recovered']);
  assert.ok(diagnostics.some((entry) => entry.event === 'laguna_runtime_contract_violation'
    && entry.details.control_tag_count > 0));
});

test('V0.2.19 continuation recovery carries bounded sanitized prior state with thinking disabled', async () => {
  const requests = [];
  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'continue research' }],
  }, {
    upstream: async (request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        return response([{ type: 'thinking', thinking: `I still need official release notes. ${'<tool_call>'.repeat(1500)}` }]);
      }
      const rendered = JSON.stringify(request.messages.at(-1));
      assert.equal(request.chat_template_kwargs.enable_thinking, false);
      assert.equal(request.chat_template_kwargs.preserve_thinking, false);
      assert.match(rendered, /Previous incomplete model state/);
      assert.doesNotMatch(rendered, /<tool_call>/);
      assert.ok(rendered.length < 12000);
      return response([{ type: 'text', text: 'recovered final' }]);
    },
    executeTool: async () => ({}),
  });
  assert.equal(result.content[0].text, 'recovered final');
  assert.equal(requests.length, 2);
});

test('V0.2.19 stops an exact repeated managed action as no progress before executing it twice', async () => {
  let calls = 0;
  let executions = 0;
  await assert.rejects(runManagedLoop({ messages: [] }, {
    upstream: async () => {
      calls += 1;
      return response([{ type: 'tool_use', id: `same-${calls}`, name: 'WebSearch', input: { query: 'same query' } }], 'tool_use');
    },
    executeTool: async () => { executions += 1; return { results: [] }; },
    maxRounds: 6,
  }), (error) => error.code === 'managed_no_progress');
  assert.equal(calls, 2);
  assert.equal(executions, 1);
});

test('V0.2.19 bounds one stalled model round independently of the Base upstream timeout', async () => {
  await assert.rejects(runManagedLoop({ messages: [] }, {
    upstream: async (_request, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
    }),
    executeTool: async () => ({}),
    modelRoundTimeoutMs: 20,
    taskTimeoutMs: 1000,
  }), (error) => error.code === 'managed_model_timeout');
});

test('V0.2.19 bounds the entire managed task across otherwise progressing rounds', async () => {
  let call = 0;
  await assert.rejects(runManagedLoop({ messages: [] }, {
    upstream: async () => {
      await new Promise((resolve) => setTimeout(resolve, 18));
      call += 1;
      return response([{ type: 'tool_use', id: `t-${call}`, name: 'WebSearch', input: { query: `q-${call}` } }], 'tool_use');
    },
    executeTool: async () => ({ results: [] }),
    maxRounds: 12,
    modelRoundTimeoutMs: 500,
    taskTimeoutMs: 45,
  }), (error) => error.code === 'managed_task_timeout');
  assert.ok(call >= 2);
});

test('V0.2.19.1 executes independent managed tool calls concurrently while preserving result order', async () => {
  let upstreamCalls = 0;
  const started = [];
  let resolveBothStarted;
  const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve; });
  let releaseTools;
  const toolGate = new Promise((resolve) => { releaseTools = resolve; });

  const run = runManagedLoop({ model: 'm', messages: [{ role: 'user', content: 'fetch two sources' }] }, {
    upstream: async (request) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return response([
          { type: 'tool_use', id: 'fetch-a', name: 'WebFetch', input: { url: 'https://a.example/' } },
          { type: 'tool_use', id: 'fetch-b', name: 'WebFetch', input: { url: 'https://b.example/' } },
        ], 'tool_use');
      }
      assert.deepEqual(request.messages.at(-1).content.map((item) => item.tool_use_id), ['fetch-a', 'fetch-b']);
      return response([{ type: 'text', text: 'parallel complete' }]);
    },
    executeTool: async (toolUse) => {
      started.push(toolUse.id);
      if (started.length === 2) resolveBothStarted('both-started');
      await toolGate;
      return { result: toolUse.id };
    },
    taskTimeoutMs: 1000,
    modelRoundTimeoutMs: 200,
  });

  const status = await Promise.race([
    bothStarted,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 40)),
  ]);
  releaseTools();
  const result = await run;
  assert.equal(status, 'both-started');
  assert.deepEqual(started, ['fetch-a', 'fetch-b']);
  assert.equal(result.content[0].text, 'parallel complete');
});


test('V0.2.19.1 normalizes mixed WebSearch domain arguments before Claude Code handoff', async () => {
  const result = await runManagedLoop({ messages: [] }, {
    upstream: async () => response([
      {
        type: 'tool_use', id: 'search-mixed', name: 'WebSearch',
        input: { query: 'openssl', allowed_domains: 'docs.openssl.org' },
      },
      { type: 'tool_use', id: 'write-mixed', name: 'Write', input: { file_path: '/project/a.c', content: 'x' } },
    ], 'tool_use'),
    executeTool: async () => { throw new Error('mixed response must hand off'); },
  });
  assert.deepEqual(result.content[0].input.allowed_domains, ['docs.openssl.org']);
  assert.equal(result.content[1].name, 'Write');
});

test('V0.2.19.1 reserves the last model-round budget by disabling only managed research tools after evidence exists', async () => {
  let upstreamCalls = 0;
  const diagnostics = [];
  const result = await runManagedLoop({
    model: 'm',
    tools: [
      { name: 'WebSearch', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
    ],
    messages: [{ role: 'user', content: 'research then continue implementation' }],
  }, {
    upstream: async (request) => {
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return response([{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'docs' } }], 'tool_use');
      }
      assert.deepEqual(request.tools.map((tool) => tool.name), ['Read']);
      return response([{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/project/a.c' } }], 'tool_use');
    },
    executeTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 55));
      return { results: [{ title: 'evidence' }] };
    },
    taskTimeoutMs: 100,
    modelRoundTimeoutMs: 60,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });
  assert.equal(result.content[0].name, 'Read');
  assert.ok(diagnostics.some((entry) => entry.event === 'managed_final_round_reserved'));
});

test('V0.2.19.2 deterministically promotes a complete thinking-only end_turn answer without another model call', async () => {
  const diagnostics = [];
  let calls = 0;
  const completedAnswer = `# 今日新聞摘要

- 第一則新聞已整理事件、日期與主要影響。
- 第二則新聞已整理官方資訊與相關背景。
- 第三則新聞已整理市場反應與後續觀察。

整體而言，今日焦點集中在天候、公共政策與市場動態。`;

  const result = await runManagedLoop({
    model: 'm',
    tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'news' }],
  }, {
    upstream: async () => {
      calls += 1;
      return response([{ type: 'thinking', thinking: completedAnswer }]);
    },
    executeTool: async () => assert.fail('promotion must not execute tools'),
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.content, [{ type: 'text', text: completedAnswer }]);
  const promoted = diagnostics.find((entry) => entry.event === 'managed_final_response_promoted');
  assert.ok(promoted);
  assert.equal(promoted.details.route, 'deterministic_final_promotion');
  assert.equal(promoted.details.source, 'thinking');
});

test('diagnostic passthrough returns ordinary WebSearch tool_use unchanged before Proxy execution', async () => {
  let executed = 0;
  const traced = [];
  const modelResponse = response([
    { type: 'tool_use', id: 'web-search-native-ui-1', name: 'WebSearch', input: { query: 'diagnostic native UI' } },
  ], 'tool_use');
  const result = await runManagedLoop({ messages: [] }, {
    upstream: async () => modelResponse,
    executeTool: async () => { executed += 1; return {}; },
    diagnosticPassthroughWebTools: async ({ toolUses }) => ({
      passthrough: true,
      tool_ids: toolUses.map((tool) => tool.id),
      tool_names: toolUses.map((tool) => tool.name),
    }),
    onTrace: async (event, payload) => traced.push({ event, payload }),
  });
  assert.equal(executed, 0);
  assert.deepEqual(result.content, modelResponse.content);
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].name, 'WebSearch');
  assert.equal(result.content[0].id, 'web-search-native-ui-1');
  assert.ok(traced.some((entry) => entry.event === 'diagnostic_web_tool_passthrough'));
});

test('V0.2.23 managed WebSearch progress follows the configured locale', async () => {
  let calls = 0;
  const progress = [];
  await runManagedLoop({ model: 'm', messages: [{ role: 'user', content: 'go' }] }, {
    locale: 'en-US',
    upstream: async () => {
      calls += 1;
      return calls === 1
        ? response([{ type: 'tool_use', id: 'tool-1', name: 'WebSearch', input: { query: 'libuv TLS' } }], 'tool_use')
        : response([{ type: 'text', text: 'done' }]);
    },
    executeTool: async () => ({ results: [{ title: 'x' }] }),
    onProgress: (message) => progress.push(message),
  });
  assert.match(progress.join('\n'), /Searching: libuv TLS…/);
  assert.match(progress.join('\n'), /Search completed: libuv TLS\./);
});
