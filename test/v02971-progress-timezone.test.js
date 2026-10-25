import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { formatProgressClock, modelTimelineHeader, progressBlockHeader } from '../src/i18n/response-language.js';
import { ProgressStream } from '../src/proxy/progress.js';

const base = { VLLM_BASE_URL: 'http://127.0.0.1:8001' };
const initialTime = Date.parse('2026-10-25T05:45:20.000Z');

class FakeResponse extends EventEmitter {
  chunks = [];
  writeHead() {}
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end() {}
}

async function makeTimeline(timezone, start = initialTime) {
  const res = new FakeResponse();
  const progress = new ProgressStream(res, {
    locale: 'zh-TW', visibleAfterMs: 0, pingIntervalMs: 60_000,
    modelResponseTimezone: timezone,
  });
  try {
    await progress.open();
    await progress.update('model round started', {
      force: true,
      details: { phase: 'managed_model_round_start', model_timeline: true, model_started_at: start, round: 1 },
    });
    await progress.update('thinking', {
      force: true,
      details: { phase: 'model_stream_phase', model_timeline: true, model_phase: 'thinking', timeline_elapsed_ms: 1_000 },
    });
    return res.chunks.join('');
  } finally {
    await progress.stop();
  }
}

test('V0.29.71 parses progress timezone independently of model runtime reminder timezone', () => {
  const config = loadConfig({ ...base, MODEL_RESPONSE_TIMEZONE: 'Asia/Taipei', PROXY_RUNTIME_TIMEZONE: 'Europe/London' });
  assert.equal(config.modelResponseTimezone, 'Asia/Taipei');
  assert.equal(config.modelResponseTimezoneInvalid, false);
  assert.equal(config.runtimeClockTimezone, 'Europe/London');
  const defaultConfig = loadConfig(base);
  assert.equal(defaultConfig.modelResponseTimezone, '');
  assert.equal(defaultConfig.modelResponseTimezoneInvalid, false);
});

test('V0.29.71 invalid progress timezone falls back to system timezone with a startup warning flag', () => {
  const invalid = loadConfig({ ...base, MODEL_RESPONSE_TIMEZONE: 'Invalid/Nowhere' });
  assert.equal(invalid.modelResponseTimezone, '');
  assert.equal(invalid.modelResponseTimezoneInvalid, true);
  assert.equal(loadConfig({ ...base, MODEL_RESPONSE_TIMEZONE: '  ' }).modelResponseTimezoneInvalid, false);
  assert.equal(loadConfig({ ...base, MODEL_RESPONSE_TIMEZONE: ' Asia/Taipei ' }).modelResponseTimezone, 'Asia/Taipei');
});

test('V0.29.71 formats UTC, Taipei and daylight-saving boundaries as HH:mm:ss', () => {
  assert.equal(formatProgressClock(initialTime, 'UTC'), '05:45:20');
  assert.equal(formatProgressClock(initialTime, 'Asia/Taipei'), '13:45:20');
  assert.equal(modelTimelineHeader('zh-TW', { timestampMs: initialTime, timeZone: 'Asia/Taipei' }), '處理中 · 13:45:20');
  assert.equal(progressBlockHeader('en-US', { timestampMs: initialTime, timeZone: 'UTC' }), 'Model processing · 05:45:20');
  assert.equal(modelTimelineHeader('zh-TW', { timeText: '12:34:56', timeZone: 'Asia/Taipei' }), '處理中 · 12:34:56');
  assert.equal(formatProgressClock(Date.parse('2026-01-01T16:00:00Z'), 'Asia/Taipei'), '00:00:00');
  assert.equal(formatProgressClock(Date.parse('2026-03-08T06:59:59Z'), 'America/New_York'), '01:59:59');
  assert.equal(formatProgressClock(Date.parse('2026-03-08T07:00:00Z'), 'America/New_York'), '03:00:00');
  assert.equal(formatProgressClock(Date.parse('2026-11-01T05:59:59Z'), 'America/New_York'), '01:59:59');
  assert.equal(formatProgressClock(Date.parse('2026-11-01T06:00:00Z'), 'America/New_York'), '01:00:00');
});

test('V0.29.71 missing timezone keeps existing process-local clock behavior', () => {
  const d = new Date(initialTime);
  const local = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  assert.equal(formatProgressClock(initialTime), local);
  assert.equal(modelTimelineHeader('zh-TW', { timestampMs: initialTime }), `處理中 · ${local}`);
});

test('V0.29.71 ProgressStream renders each request timezone independently without changing seconds', async () => {
  const [taipei, utc] = await Promise.all([makeTimeline('Asia/Taipei'), makeTimeline('UTC')]);
  assert.match(taipei, /處理中 · 13:45:20 ○ 1s ◐/);
  assert.match(utc, /處理中 · 05:45:20 ○ 1s ◐/);
  assert.doesNotMatch(taipei, /05:45:20/);
  assert.doesNotMatch(utc, /13:45:20/);
});

test('V0.29.71 Compose and ENV example expose the progress timezone independently', async () => {
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(compose, /MODEL_RESPONSE_TIMEZONE:\s*\$\{MODEL_RESPONSE_TIMEZONE:-\}/);
  assert.match(example, /^MODEL_RESPONSE_TIMEZONE=$/m);
  assert.match(compose, /PROXY_RUNTIME_TIMEZONE:\s*\$\{PROXY_RUNTIME_TIMEZONE:-Asia\/Taipei\}/);
});

test('V0.29.71 actual HTTP SSE progress gets timezone in ordinary and managed requests', async (t) => {
  const http = await import('node:http');
  const { once } = await import('node:events');
  const { createProxyServer } = await import('../src/services/proxy-server.js');
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {};
    if (req.url.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":3}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.end(sse('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 3, output_tokens: 0 }, stop_reason: null } }) +
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ANSWER' } }) +
      sse('content_block_stop', { index: 0 }) +
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
      sse('message_stop', {}));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const forwardedTimezones = [];
  const config = {
    ...loadConfig({ ...base, VLLM_BASE_URL: upstreamUrl, MODEL_RESPONSE_TIMEZONE: 'Asia/Taipei',
      COMPLETION_PROBE_ENABLED: 'false', MODEL_RESPONSE_LANGUAGE: 'zh-TW', LOG_LEVEL: 'error' }),
    usagePreflightEnabled: false, progressVisibleAfterMs: 0, progressPingIntervalMs: 60_000,
  };
  const proxy = createProxyServer(config, {
    progressStreamFactory: (res, options) => {
      forwardedTimezones.push(options.modelResponseTimezone);
      return new ProgressStream(res, options);
    },
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  for (const tools of [undefined, [{ name: 'Read', description: 'Read text', input_schema: { type: 'object', properties: {} } }]]) {
    const before = Date.now();
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true, max_tokens: 64, tools,
        messages: [{ role: 'user', content: 'Say ANSWER' }] }),
    });
    const wire = await response.text();
    const after = Date.now();
    assert.equal(response.status, 200, wire);
    assert.match(wire, /ANSWER/);
    const actual = wire.match(/處理中 · (\d\d:\d\d:\d\d)/)?.[1];
    assert.ok(actual, `missing progress clock in ${tools ? 'managed' : 'unmanaged'} SSE`);
    const validTimes = new Set([before, after].flatMap(ms => [ms - 1000, ms, ms + 1000])
      .map(ms => formatProgressClock(ms, 'Asia/Taipei')));
    assert.ok(validTimes.has(actual), `clock ${actual} not in expected range ${[...validTimes].join(', ')}`);
  }
  assert.deepEqual(forwardedTimezones, ['Asia/Taipei', 'Asia/Taipei']);
});
