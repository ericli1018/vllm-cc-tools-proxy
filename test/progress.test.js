import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  PROGRESS_BLOCK_HEADER,
  ProgressStream,
  hasProgressHistory,
  stripProgressHistory,
} from '../src/proxy/progress.js';
import { pipeAnthropicUpstreamStream } from '../src/proxy/anthropic-sse.js';
import { totalAnthropicInputTokens } from '../src/proxy/anthropic-usage.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headers = null;
    this.status = null;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk = '') {
    if (chunk) this.chunks.push(String(chunk));
    this.ended = true;
  }
}

test('ProgressStream emits the V0.2.8 progress header without a V0.2.2 nonce sentinel', async () => {
  assert.equal(PROGRESS_BLOCK_HEADER, '目前處理進度：');
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.update('正在解析 PDF…', { force: true });
  await progress.closeProgress('處理完成；正在回傳模型結果…');
  await progress.stop();

  const stream = response.chunks.join('');
  assert.match(stream, new RegExp(PROGRESS_BLOCK_HEADER));
  assert.match(stream, /正在解析 PDF/);
  assert.doesNotMatch(stream, /VLLMCCP:v1:/);
  assert.doesNotMatch(stream, /\u2063/);
});



test('V0.2.28.14 progress header does not sample live upstream bytes during delayed visibility', async () => {
  const response = new FakeResponse();
  let samples = 0;
  const progress = new ProgressStream(response, {
    visibleAfterMs: 20,
    pingIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    getReceivedBytes: () => {
      samples += 1;
      return 647;
    },
  });
  await progress.open();
  await progress.update('◐ 主模型開始思考 · 510 B', { details: { phase: 'model_stream_phase' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await progress.closeProgress();
  await progress.stop();

  const stream = response.chunks.join('');
  assert.match(stream, /目前處理進度：/);
  assert.match(stream, /◐ 主模型開始思考 · 510 B/);
  assert.doesNotMatch(stream, /目前處理進度（已收到/);
  assert.equal(samples, 0);
});

test('stripProgressHistory removes a dedicated V0.2.3 progress block and keeps model blocks', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: `${PROGRESS_BLOCK_HEADER}\n正在解析 PDF…\n處理完成；正在回傳模型結果…` },
      { type: 'thinking', thinking: 'model thought', signature: 'sig' },
      { type: 'text', text: '真正答案' },
    ],
  }];
  const result = stripProgressHistory(messages);
  assert.deepEqual(result[0].content, [
    { type: 'thinking', thinking: 'model thought', signature: 'sig' },
    { type: 'text', text: '真正答案' },
  ]);
});

test('hasProgressHistory detects the dedicated V0.2.3 progress block', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: `${PROGRESS_BLOCK_HEADER}\n正在解析 PDF…` }] }];
  assert.equal(hasProgressHistory(messages), true);
});



test('stripProgressHistory removes the V0.2.5 legacy readable progress header', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: 'VLLM-CC-TOOLS-PROXY 進度：\n正在解析 PDF…\n處理完成；正在回傳模型結果…' },
      { type: 'text', text: '真正答案' },
    ],
  }];
  assert.equal(hasProgressHistory(messages), true);
  assert.deepEqual(stripProgressHistory(messages)[0].content, [{ type: 'text', text: '真正答案' }]);
});
test('stripProgressHistory removes V0.2.2 invisible sentinel region for backward compatibility', () => {
  const start = '\u2063VLLMCCP:v1:abc123:start\u2063';
  const end = '\u2063VLLMCCP:v1:abc123:end\u2063';
  const messages = [{
    role: 'assistant',
    content: [{ type: 'text', text: `${start}正在解析 PDF…${end}\n\n真正答案` }],
  }];
  const result = stripProgressHistory(messages);
  assert.equal(result[0].content[0].text, '\n\n真正答案');
});

test('stripProgressHistory removes V0.2.2 markers even when invisible separators were normalized away', () => {
  const messages = [{
    role: 'assistant',
    content: [{ type: 'text', text: 'VLLMCCP:v1:abc123:start處理完成；正在回傳模型結果…VLLMCCP:v1:abc123:end\n真正答案' }],
  }];
  const result = stripProgressHistory(messages);
  assert.equal(result[0].content[0].text, '\n真正答案');
});

test('stripProgressHistory preserves ordinary assistant text', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: '正在解析 PDF，但這是模型答案。' }] }];
  assert.deepEqual(stripProgressHistory(messages), messages);
  assert.equal(hasProgressHistory(messages), false);
});

test('closeProgress does not create a progress block when no progress became visible', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 60_000, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.closeProgress('處理完成；正在回傳模型結果…');
  await progress.stop();

  const stream = response.chunks.join('');
  assert.equal(progress.visible, false);
  assert.doesNotMatch(stream, new RegExp(PROGRESS_BLOCK_HEADER));
  assert.doesNotMatch(stream, /處理完成；正在回傳模型結果/);
  assert.doesNotMatch(stream, /event: content_block_start/);
});

test('managed keepalive continues through upstream TTFT and stops before message_stop', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 10 });
  await progress.open();
  await progress.update('正在解析 PDF…', { force: true });
  const encoder = new TextEncoder();
  const upstream = new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n')), 25);
      setTimeout(() => controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n')), 50);
      setTimeout(() => {
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      }, 75);
    },
  }), { headers: { 'content-type': 'text/event-stream' } });

  await pipeAnthropicUpstreamStream(progress, upstream);
  const stream = response.chunks.join('');
  const pingCount = (stream.match(/event: ping/g) || []).length;
  assert.ok(pingCount >= 3, `expected periodic pings, received ${pingCount}`);
  assert.match(stream, /"text":"OK"/);
  assert.ok(stream.lastIndexOf('event: ping') < stream.lastIndexOf('event: message_stop'));
  for (const line of stream.split(/\r?\n/).filter((item) => item.startsWith('data: '))) {
    assert.doesNotThrow(() => JSON.parse(line.slice(6)));
  }
});

test('semantic heartbeat emits real text deltas and reports successful writes', async () => {
  const response = new FakeResponse();
  const writes = [];
  let ticks = 0;
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    heartbeatIntervalMs: 15,
    onWrite: (entry) => writes.push(entry),
  });
  await progress.open();
  await progress.update('檔案：board.pdf｜狀態：正在處理…', { force: true, details: { phase: 'pdf_start' } });
  progress.startSemanticHeartbeat(() => `檔案：board.pdf｜狀態：主模型仍在處理中，已等待 ${++ticks * 15} 毫秒…`);
  await new Promise((resolve) => setTimeout(resolve, 42));
  progress.stopSemanticHeartbeat();
  await progress.closeProgress();
  await progress.stop();

  const stream = response.chunks.join('');
  assert.match(stream, /主模型仍在處理中/);
  assert.ok((stream.match(/content_block_delta/g) || []).length >= 2);
  assert.ok(writes.some((entry) => entry.kind === 'semantic_heartbeat' && entry.bytes > 0));
  assert.ok(writes.some((entry) => entry.kind === 'progress_delta' && entry.phase === 'pdf_start'));
});

test('upstream progress remains open through first-event wait and heartbeat stops before model content', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, heartbeatIntervalMs: 10 });
  await progress.open();
  await progress.update('檔案：board.pdf｜狀態：正在交給主模型分析…', { force: true });
  progress.startSemanticHeartbeat(() => '檔案：board.pdf｜狀態：主模型仍在處理中…');
  const encoder = new TextEncoder();
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
      setTimeout(() => controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')), 35);
      setTimeout(() => {
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"MODEL"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      }, 45);
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  await pipeAnthropicUpstreamStream(progress, upstream);
  const stream = response.chunks.join('');
  const heartbeatAt = stream.indexOf('主模型仍在處理中');
  const modelAt = stream.indexOf('MODEL');
  assert.ok(heartbeatAt >= 0 && heartbeatAt < modelAt);
  assert.ok(stream.indexOf('content_block_stop') < modelAt);
  assert.equal(progress.semanticHeartbeatTimer, null);
});

test('pre-threshold progress retains the latest pending state and reveals it at the visibility threshold', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 30,
    pingIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });
  await progress.open();
  await progress.update('狀態 A', { details: { phase: 'a' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await progress.update('狀態 B', { details: { phase: 'b' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await progress.closeProgress();
  await progress.stop();

  const stream = response.chunks.join('');
  assert.equal(progress.visible, true);
  assert.doesNotMatch(stream, /狀態 A/);
  assert.match(stream, /狀態 B/);
});

test('equal progress text with different structured state revisions is delivered twice', async () => {
  const response = new FakeResponse();
  const writes = [];
  const changes = [];
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    onWrite: (entry) => writes.push(entry),
    onStateChange: (entry) => changes.push(entry),
  });
  await progress.open();
  await progress.update('正在準備圖片…', { details: { phase: 'image_prepare', page: 1 } });
  await progress.update('正在準備圖片…', { details: { phase: 'image_prepare', page: 2 } });
  await progress.closeProgress();
  await progress.stop();

  const stream = response.chunks.join('');
  assert.equal((stream.match(/正在準備圖片/g) || []).length, 2);
  assert.deepEqual(changes.map((entry) => entry.revision), [1, 2]);
  const stateWrites = writes.filter((entry) => entry.kind === 'progress_delta');
  assert.deepEqual(stateWrites.map((entry) => entry.revision), [1, 2]);
  assert.ok(stateWrites.every((entry) => Number.isInteger(entry.deliveryLatencyMs)));
});


test('closeProgress preserves response-aware phase and terminal scope metadata', async () => {
  const response = new FakeResponse();
  const changes = [];
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    onStateChange: (entry) => changes.push(entry),
  });
  await progress.open();
  await progress.update('主模型仍在處理本輪請求…', { force: true, details: { phase: 'waiting_for_model' } });
  await progress.closeProgress('主模型已產生下一步 Write；正在交還 Claude Code 執行…', {
    phase: 'handoff_to_claude_code',
    details: {
      terminal_for_proxy: true,
      terminal_for_claude_task: false,
      tool_names: ['Write'],
    },
  });
  await progress.stop();
  assert.equal(changes.at(-1).phase, 'handoff_to_claude_code');
  assert.match(response.chunks.join(''), /正在交還 Claude Code 執行/);
});

test('ProgressStream message_start preserves preflight input and cache usage', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 60_000,
    pingIntervalMs: 60_000,
    initialUsage: {
      input_tokens: 180000,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 3400,
      output_tokens: 0,
    },
  });
  await progress.open();
  await progress.stop();

  const stream = response.chunks.join('');
  assert.match(stream, /"input_tokens":180000/);
  assert.match(stream, /"cache_creation_input_tokens":1200/);
  assert.match(stream, /"cache_read_input_tokens":3400/);
});

test('V0.2.23 ProgressStream emits localized headers and strips every supported locale header', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { locale: 'ja-JP', visibleAfterMs: 0, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.update('処理中…', { force: true });
  await progress.stop();
  assert.match(response.chunks.join(''), /現在の処理状況：/);

  for (const header of ['目前處理進度：', '当前处理进度：', 'Current progress:', '現在の処理状況：', '현재 처리 상태:']) {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: `${header}\nstatus` }, { type: 'text', text: 'answer' }] }];
    assert.equal(hasProgressHistory(messages), true);
    assert.deepEqual(stripProgressHistory(messages)[0].content, [{ type: 'text', text: 'answer' }]);
  }
});

test('V0.2.28.14 ProgressStream keeps the first visible header stable while byte telemetry stays in state lines', async () => {
  const response = new FakeResponse();
  let receivedBytes = 20;
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    locale: 'zh-TW',
    getReceivedBytes: () => receivedBytes,
  });
  await progress.open();
  await progress.update('正在將內容送往主模型…', { force: true });
  await progress.closeProgress();
  await progress.stop();

  const stream = response.chunks.join('');
  assert.match(stream, /目前處理進度：/);
  assert.doesNotMatch(stream, /目前處理進度（已收到/);
});

test('V0.2.24 dynamic byte progress header is recognized and stripped from history', () => {
  const header = '目前處理進度（已收到 1.22 KB）：';
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: `${header}\n主模型仍在處理本輪請求，已等待 30 秒（已收到 1.22 KB）…` },
      { type: 'text', text: '真正答案' },
    ],
  }];
  assert.equal(hasProgressHistory(messages), true);
  assert.deepEqual(stripProgressHistory(messages)[0].content, [{ type: 'text', text: '真正答案' }]);
});

test('V0.2.28.8 ProgressStream replaces preflight total with cache-split input usage atomically', () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 60_000,
    pingIntervalMs: 60_000,
    initialUsage: {
      input_tokens: 197500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
  });

  const merged = progress.usageForDelta({
    input_tokens: 5000,
    cache_read_input_tokens: 192500,
    output_tokens: 25,
  });

  assert.deepEqual(merged, {
    input_tokens: 5000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 192500,
    output_tokens: 25,
  });
  assert.equal(totalAnthropicInputTokens(merged), 197500);
  progress.stopKeepalive();
});

test('V0.2.28.8 managed SSE does not double-count vLLM cache-split usage after preflight total', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 60_000,
    pingIntervalMs: 60_000,
    initialUsage: { input_tokens: 197500, output_tokens: 0 },
  });
  await progress.open();

  const encoder = new TextEncoder();
  const upstream = new Response(new ReadableStream({
    start(controller) {
      const frames = [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5000,"cache_creation_input_tokens":0,"cache_read_input_tokens":192500,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":5000,"cache_creation_input_tokens":0,"cache_read_input_tokens":192500,"output_tokens":25}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });

  await pipeAnthropicUpstreamStream(progress, upstream);
  const stream = response.chunks.join('');
  assert.match(stream, /"input_tokens":5000/);
  assert.match(stream, /"cache_read_input_tokens":192500/);
  assert.doesNotMatch(stream, /"input_tokens":197500[^\n]*"cache_read_input_tokens":192500/);
});

test('V0.2.28.8 ProgressStream preserves authoritative input tuple on output-only usage delta', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 60_000,
    pingIntervalMs: 60_000,
    initialUsage: { input_tokens: 197500, output_tokens: 0 },
  });

  await progress.updateUsage({
    input_tokens: 5000,
    cache_read_input_tokens: 192500,
    output_tokens: 20,
  });

  const outputOnly = progress.usageForDelta({ output_tokens: 55 });
  assert.deepEqual(outputOnly, {
    input_tokens: 5000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 192500,
    output_tokens: 55,
  });
  assert.equal(totalAnthropicInputTokens(outputOnly), 197500);
  await progress.stop();
});

test('V0.2.27.1 ProgressStream can publish exact cumulative input usage after early message_start', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    initialUsage: { input_tokens: 80000, output_tokens: 0 },
  });
  await progress.open();
  await progress.update('正在解析 PDF…', { force: true, details: { phase: 'pdf_start' } });
  await progress.updateUsage({ input_tokens: 120000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, {
    phase: 'media_usage_exact',
  });
  await progress.stop();

  const stream = response.chunks.join('');
  const startPos = stream.indexOf('"input_tokens":80000');
  const exactPos = stream.indexOf('"input_tokens":120000');
  assert.ok(startPos >= 0);
  assert.ok(exactPos > startPos);
  assert.match(stream, /event: message_delta/);
  assert.match(stream, /"stop_reason":null/);
});

test('V0.2.28.12 startup banner is a removable proxy-owned progress block', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.showStartupBanner([
    '╭─◆ CC TOOL PROXY ─────────────────────────────╮',
    '│  VERSION   0.2.28.14          UPTIME  2h18m  │',
    '│  SESSIONS  3        ACTIVE  2        WAIT  0  │',
    '│  COMPACT ● ON       LANG ● ON       VISION ● │',
    '╰───────────────────────────────────────────────╯',
  ].join('\n'));
  await progress.closeProgress();
  await progress.stop();
  const stream = response.chunks.join('');
  assert.match(stream, /CC TOOL PROXY/);
  assert.doesNotMatch(stream, /目前處理進度：/);

  const messages = [{ role: 'assistant', content: [{ type: 'text', text: [
    '╭─◆ CC TOOL PROXY ─────────────────────────────╮',
    '│  VERSION   0.2.28.14          UPTIME  2h18m  │',
    '╰───────────────────────────────────────────────╯',
  ].join('\n') }, { type: 'text', text: '真正答案' }] }];
  assert.equal(hasProgressHistory(messages), true);
  assert.deepEqual(stripProgressHistory(messages)[0].content, [{ type: 'text', text: '真正答案' }]);
});

test('V0.2.28.16 semantic heartbeat appends each liveness sample as a new visible line', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
    locale: 'zh-TW',
  });
  await progress.open();
  await progress.update('◐ 主模型開始思考 · 510 B', { force: true, details: { phase: 'model_stream_phase' } });
  await progress.update('◐ 主模型思考中 · 29s · 20.87 KB', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('◓ 主模型思考中 · 59s · 44.02 KB · 790 B/s', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.closeProgress();
  await progress.stop();

  const deltas = response.chunks.join('').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((data) => data?.type === 'content_block_delta')
    .map((data) => data.delta?.text || '');

  assert.equal(deltas[0], '目前處理進度：\n◐ 主模型開始思考 · 510 B');
  assert.equal(deltas[1], '\n◐ 主模型思考中 · 29s · 20.87 KB');
  assert.equal(deltas[2], '\n◓ 主模型思考中 · 59s · 44.02 KB · 790 B/s');
  assert.doesNotMatch(deltas.join(''), /\x1b\[/);
});

test('V0.2.28.16 milestone after heartbeat appends normally without cursor control', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000, locale: 'zh-TW' });
  await progress.open();
  await progress.update('◐ 主模型開始思考 · 510 B', { force: true, details: { phase: 'model_stream_phase' } });
  await progress.update('◓ 主模型思考中 · 59s · 44.02 KB · 790 B/s', { force: true, kind: 'semantic_heartbeat', details: { phase: 'semantic_heartbeat' } });
  await progress.update('◆ 主模型開始回應 · 44.61 KB', { force: true, details: { phase: 'model_stream_phase' } });
  await progress.closeProgress();
  await progress.stop();

  const deltas = response.chunks.join('').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((data) => data?.type === 'content_block_delta')
    .map((data) => data.delta?.text || '');

  assert.equal(deltas[1], '\n◓ 主模型思考中 · 59s · 44.02 KB · 790 B/s');
  assert.equal(deltas[2], '\n◆ 主模型開始回應 · 44.61 KB');
});

test('V0.2.28.16 shorter heartbeat is appended without padding or ANSI cursor control', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, { visibleAfterMs: 0, pingIntervalMs: 60_000 });
  await progress.open();
  await progress.update('phase', { force: true });
  await progress.update('LONG-LIVE-STATUS-12345', { force: true, kind: 'semantic_heartbeat' });
  await progress.update('SHORT', { force: true, kind: 'semantic_heartbeat' });
  await progress.closeProgress();
  await progress.stop();

  const deltas = response.chunks.join('').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((data) => data?.type === 'content_block_delta')
    .map((data) => data.delta?.text || '');
  const appended = deltas[2];
  assert.equal(appended, '\nSHORT');
  assert.doesNotMatch(appended, /\r|\x1b/);
});

test('V0.2.28.15 progress history containing carriage-return live updates is still stripped before model reuse', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: '目前處理進度：\n◐ 主模型開始思考 · 510 B\n◐ 主模型思考中 · 29s\r◓ 主模型思考中 · 59s\n◆ 主模型開始回應 · 44.61 KB' },
      { type: 'text', text: '真正答案' },
    ],
  }];
  assert.equal(hasProgressHistory(messages), true);
  assert.deepEqual(stripProgressHistory(messages)[0].content, [{ type: 'text', text: '真正答案' }]);
});

test('V0.2.28.16 semantic heartbeat keeps append-only 30-second liveness lines and does not emit carriage-return redraws', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });
  await progress.open();
  await progress.update('◐ 主模型開始思考 · 511 B', { force: true, details: { phase: 'model_stream_phase' } });
  await progress.update('◐ 主模型思考中 · 29s · 22.56 KB', { force: true, kind: 'semantic_heartbeat' });
  await progress.update('◓ 主模型思考中 · 59s · 44.83 KB · 760 B/s', { force: true, kind: 'semantic_heartbeat' });
  await progress.stop();

  const deltas = response.chunks.join('').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((data) => data?.type === 'content_block_delta')
    .map((data) => data.delta?.text || '');
  assert.equal(deltas[1], '\n◐ 主模型思考中 · 29s · 22.56 KB');
  assert.equal(deltas[2], '\n◓ 主模型思考中 · 59s · 44.83 KB · 760 B/s');
  assert.doesNotMatch(deltas.join(''), /\r|\x1b/);
});

test('V0.2.28.20 progress history stripping does not clone untouched user Base64 media messages', () => {
  const userMessage = { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } }] };
  const progressMessage = { role: 'assistant', content: [{ type: 'text', text: '目前處理進度：\n  ◐ 主模型思考中' }] };
  const result = stripProgressHistory([userMessage, progressMessage]);
  assert.equal(result[0], userMessage);
  assert.equal(result[0].content[0].source.data, 'QUJD');
});

test('V0.29.12 ProgressStream dispose clears every timer, pending state, and is idempotent', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 60_000,
    pingIntervalMs: 60_000,
    heartbeatIntervalMs: 60_000,
  });
  await progress.open();
  await progress.update('pending', { details: { phase: 'pending' } });
  progress.startSemanticHeartbeat(() => 'heartbeat');

  assert.ok(progress.pingTimer);
  assert.ok(progress.semanticHeartbeatTimer);
  assert.ok(progress.pendingTimer);
  assert.ok(progress.pendingUpdate);

  await progress.dispose();
  await progress.dispose();

  assert.equal(progress.closed, true);
  assert.equal(progress.pingTimer, null);
  assert.equal(progress.semanticHeartbeatTimer, null);
  assert.equal(progress.pendingTimer, null);
  assert.equal(progress.pendingUpdate, null);
  assert.equal(progress.res, null);
});

test('V0.29.17 title-anchored subagent progress keeps the Agent description on the first visible line', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    progressTitle: '分析 WebSearch 行為',
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    locale: 'zh-TW',
  });
  await progress.open();
  await progress.update('主模型仍在處理…', { details: { phase: 'semantic_heartbeat' } });
  await progress.closeProgress();
  await progress.stop();
  const wire = response.chunks.join('');
  assert.match(wire, /分析 WebSearch 行為\\n目前處理進度：\\n主模型仍在處理/);
});

test('V0.29.17 history stripping removes title-anchored progress blocks from model context', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: '分析 WebSearch 行為\n目前處理進度：\n主模型仍在處理…' }] }];
  assert.equal(hasProgressHistory(messages), true);
  assert.deepEqual(stripProgressHistory(messages)[0].content, []);
});


test('V0.29.18 title-anchored Sub Agent progress repeats the stable title and header on every visible delta', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    progressTitle: '分析 WebSearch 行為',
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    locale: 'zh-TW',
  });
  await progress.open();
  await progress.update('等待模型第一個位元組…', { details: { phase: 'semantic_heartbeat' } });
  await progress.update('主模型開始思考…', { details: { phase: 'model_stream_phase' } });
  await progress.update('主模型正在處理工具…', { details: { phase: 'model_stream_phase' } });
  await progress.closeProgress();
  await progress.stop();

  const wire = response.chunks.join('');
  const titleCount = (wire.match(/分析 WebSearch 行為/g) || []).length;
  const headerCount = (wire.match(/目前處理進度：/g) || []).length;
  assert.equal(titleCount, 3);
  assert.equal(headerCount, 3);
  assert.match(wire, /分析 WebSearch 行為\\n目前處理進度：\\n等待模型第一個位元組/);
  assert.match(wire, /分析 WebSearch 行為\\n目前處理進度：\\n主模型開始思考/);
  assert.match(wire, /分析 WebSearch 行為\\n目前處理進度：\\n主模型正在處理工具/);
});

test('V0.29.18 Main Agent progress keeps the V0.29.17 append-only format without repeated headers', async () => {
  const response = new FakeResponse();
  const progress = new ProgressStream(response, {
    visibleAfterMs: 0,
    pingIntervalMs: 60_000,
    locale: 'zh-TW',
  });
  await progress.open();
  await progress.update('等待模型第一個位元組…', { details: { phase: 'semantic_heartbeat' } });
  await progress.update('主模型開始思考…', { details: { phase: 'model_stream_phase' } });
  await progress.closeProgress();
  await progress.stop();

  const wire = response.chunks.join('');
  const headerCount = (wire.match(/目前處理進度：/g) || []).length;
  assert.equal(headerCount, 1);
  assert.match(wire, /目前處理進度：\\n等待模型第一個位元組/);
  assert.doesNotMatch(wire, /目前處理進度：\\n主模型開始思考/);
});
