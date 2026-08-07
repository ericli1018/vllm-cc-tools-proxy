import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  describeFinalAnthropicProgress,
  emitFinalAnthropicResponse,
  pipeAnthropicUpstreamStream,
  createServerToolStreamBridge,
} from '../src/proxy/anthropic-sse.js';

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test('managed Anthropic stream diagnoses split control tags without rewriting upstream text', async () => {
  const chunks = [
    event('message_start', { type: 'message_start' }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x </func' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'tion_result> y' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '<tool_call>' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('message_stop', { type: 'message_stop' }),
  ];
  const writes = [];
  const diagnostics = [];
  const progress = {
    visible: false,
    closeProgress: async () => {},
    writeRaw: async (value) => writes.push(value),
    stopKeepalive: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  const upstream = { body: Readable.from(chunks.map((chunk) => Buffer.from(chunk))) };
  await pipeAnthropicUpstreamStream(progress, upstream, {
    onDiagnostic: (eventName, details) => diagnostics.push({ eventName, details }),
  });
  assert.match(writes.join(''), /<tool_call>/);
  assert.match(writes.join(''), /<\/func/);
  assert.match(writes.join(''), /tion_result>/);
  assert.deepEqual(diagnostics, [{
    eventName: 'base_generation_control_tags_detected',
    details: {
      tagCount: 2,
      tags: ['function_result', 'tool_call'],
      channels: ['thinking', 'text'],
    },
  }]);
});


test('describeFinalAnthropicProgress distinguishes visible answers from Claude Code tool handoff', () => {
  assert.deepEqual(describeFinalAnthropicProgress({
    content: [{ type: 'text', text: 'Done' }],
    stop_reason: 'end_turn',
  }), {
    message: '主模型已完成本輪回答；正在回傳結果…',
    phase: 'returning_visible_response',
    details: {
      terminal_for_proxy: true,
      terminal_for_claude_task: false,
      response_disposition: 'visible_response',
      tool_names: [],
    },
  });

  assert.deepEqual(describeFinalAnthropicProgress({
    content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', id: 'w1', name: 'Write', input: {} }],
    stop_reason: 'tool_use',
  }), {
    message: '主模型已產生下一步 Write；正在交還 Claude Code 執行…',
    phase: 'handoff_to_claude_code',
    details: {
      terminal_for_proxy: true,
      terminal_for_claude_task: false,
      response_disposition: 'tool_handoff',
      tool_names: ['Write'],
    },
  });

  assert.equal(describeFinalAnthropicProgress({
    content: [
      { type: 'tool_use', id: 'r1', name: 'Read', input: {} },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: {} },
    ],
  }).message, '主模型已產生下一步工具；正在交還 Claude Code 執行…');

  assert.equal(describeFinalAnthropicProgress({
    content: [{ type: 'thinking', thinking: 'internal only' }],
  }).phase, 'returning_model_output');
});

test('emitFinalAnthropicResponse closes progress with tool-handoff semantics', async () => {
  const closes = [];
  const writes = [];
  const progress = {
    visible: true,
    closeProgress: async (message, options) => closes.push({ message, options }),
    writeRaw: async (chunk) => writes.push(chunk),
    stopKeepalive: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  await emitFinalAnthropicResponse(progress, {
    content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/tmp/x' } }],
    stop_reason: 'tool_use',
    usage: { output_tokens: 5 },
  });
  assert.deepEqual(closes, [{
    message: '主模型已產生下一步 Write；正在交還 Claude Code 執行…',
    options: {
      phase: 'handoff_to_claude_code',
      details: {
        terminal_for_proxy: true,
        terminal_for_claude_task: false,
        response_disposition: 'tool_handoff',
        tool_names: ['Write'],
      },
    },
  }]);
  assert.match(writes.join(''), /"name":"Write"/);
});

test('pipeAnthropicUpstreamStream closes visible progress according to the first model block type', async () => {
  const closes = [];
  const progress = {
    visible: true,
    closeProgress: async (message, options) => closes.push({ message, options }),
    writeRaw: async () => {},
    stopKeepalive: () => {},
    stopSemanticHeartbeat: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  const chunks = [
    event('message_start', { type: 'message_start' }),
    event('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'w1', name: 'Write', input: {} },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_stop', { type: 'message_stop' }),
  ];
  await pipeAnthropicUpstreamStream(progress, { body: Readable.from(chunks.map((chunk) => Buffer.from(chunk))) });
  assert.deepEqual(closes, [{
    message: '主模型已開始回傳下一步工具…',
    options: {
      phase: 'streaming_tool_action',
      details: {
        terminal_for_proxy: false,
        terminal_for_claude_task: false,
        response_disposition: 'tool_handoff',
        tool_names: ['Write'],
      },
    },
  }]);
});

test('pipeAnthropicUpstreamStream observes upstream usage without forwarding a second message_start', async () => {
  const writes = [];
  const observed = [];
  const progress = {
    visible: false,
    closeProgress: async () => {},
    writeRaw: async (value) => writes.push(value),
    stopKeepalive: () => {},
    stopSemanticHeartbeat: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  const chunks = [
    event('message_start', {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 180000,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 3400,
          output_tokens: 0,
        },
      },
    }),
    event('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 25 },
    }),
    event('message_stop', { type: 'message_stop' }),
  ];

  await pipeAnthropicUpstreamStream(progress, {
    body: Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
  }, {
    onUsage: (entry) => observed.push(entry),
  });

  assert.equal((writes.join('').match(/event: message_start/g) || []).length, 0);
  assert.deepEqual(observed, [
    {
      stage: 'message_start',
      usage: {
        input_tokens: 180000,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 3400,
        output_tokens: 0,
      },
    },
    { stage: 'message_delta', usage: { input_tokens: 0, output_tokens: 25 } },
  ]);
});


test('V0.2.20 emits server web lifecycle blocks and server-tool usage to Claude Code', async () => {
  const writes = [];
  const closes = [];
  const progress = {
    visible: false,
    closeProgress: async (message, options) => closes.push({ message, options }),
    writeRaw: async (chunk) => writes.push(chunk),
    stopKeepalive: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  await emitFinalAnthropicResponse(progress, {
    content: [
      { type: 'server_tool_use', id: 'srvtoolu_s1', name: 'web_search', input: { query: 'news' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_s1', content: [{ type: 'web_search_result', title: 'A', url: 'https://example.com' }] },
      { type: 'text', text: 'VISIBLE' },
    ],
    stop_reason: 'end_turn', usage: { output_tokens: 3, server_tool_use: { web_search_requests: 1 } },
  });
  const stream = writes.join('');
  assert.match(stream, /server_tool_use/);
  assert.match(stream, /web_search_tool_result/);
  assert.match(stream, /web_search_requests/);
  assert.match(stream, /VISIBLE/);
});

test('V0.2.21 server_tool_use start block includes required empty input object', async () => {
  const writes = [];
  const progress = {
    visible: false,
    closeProgress: async () => {},
    writeRaw: async (chunk) => writes.push(chunk),
    stopKeepalive: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  const bridge = createServerToolStreamBridge(progress);
  await bridge.emit({ phase: 'use', block: { type: 'server_tool_use', id: 'srvtoolu_schema', name: 'web_search', input: { query: 'taiwan news' } } });
  const stream = writes.join('');
  assert.match(stream, /\"content_block\":\{\"type\":\"server_tool_use\",\"id\":\"srvtoolu_schema\",\"name\":\"web_search\",\"input\":\{\}\}/);
});

test('V0.2.20 live server-tool bridge closes progress once and advances final content indexes', async () => {
  const writes = [];
  let closeCount = 0;
  const progress = {
    visible: true,
    closeProgress: async () => { closeCount += 1; },
    writeRaw: async (chunk) => writes.push(chunk),
    stopKeepalive: () => {},
    stop: async () => {},
    res: { end: () => {} },
  };
  const bridge = createServerToolStreamBridge(progress);
  await bridge.emit({ phase: 'use', block: { type: 'server_tool_use', id: 'srvtoolu_s', name: 'web_search', input: { query: 'q' } } });
  await bridge.emit({ phase: 'result', block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_s', content: [] } });
  assert.equal(bridge.nextIndex, 3);
  await emitFinalAnthropicResponse(progress, {
    content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
  }, { startIndex: bridge.nextIndex });
  assert.ok(closeCount >= 1);
  const stream = writes.join('');
  assert.match(stream, /"index":1/);
  assert.match(stream, /"index":2/);
  assert.match(stream, /"index":3/);
});

test('V0.2.23 Anthropic progress descriptions use the configured locale', () => {
  assert.equal(describeFinalAnthropicProgress({ content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: {} }] }, { locale: 'en-US' }).message,
    'The main model produced the next Write action; handing control back to Claude Code…');
  assert.equal(describeFinalAnthropicProgress({ content: [{ type: 'text', text: 'ok' }] }, { locale: 'ja-JP' }).message,
    'メインモデルの応答が完了しました。結果を返しています…');
});
