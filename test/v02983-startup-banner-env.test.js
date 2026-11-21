import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function read(req) {
  const pieces = [];
  for await (const piece of req) pieces.push(piece);
  return JSON.parse(Buffer.concat(pieces).toString('utf8'));
}
const payload = {
  model: 'claude-opus-5-5', stream: true,
  tools: [{ name: 'Bash', description: 'Run shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Say READY.' }] }],
};

function responseEvents() {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg-test","type":"message","role":"assistant","model":"backend-model","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"READY"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '', '',
  ].join('\n');
}

test('V0.29.83 PROXY_STARTUP_BANNER_ENABLED is opt-out, strictly parsed, and independent of runtime time/progress', () => {
  const base = { VLLM_BASE_URL: 'http://127.0.0.1:8000' };
  const defaults = loadConfig(base);
  const enabled = loadConfig({ ...base, PROXY_STARTUP_BANNER_ENABLED: 'true' });
  const disabled = loadConfig({ ...base, PROXY_STARTUP_BANNER_ENABLED: 'false' });
  assert.equal(defaults.proxyStartupBannerEnabled, true);
  assert.equal(enabled.proxyStartupBannerEnabled, true);
  assert.equal(disabled.proxyStartupBannerEnabled, false);
  assert.equal(disabled.runtimeClockEnabled, defaults.runtimeClockEnabled);
  assert.equal(disabled.progressVisibleAfterMs, defaults.progressVisibleAfterMs);
  assert.throws(() => loadConfig({ ...base, PROXY_STARTUP_BANNER_ENABLED: 'off' }), /PROXY_STARTUP_BANNER_ENABLED/);
});

for (const tools of [payload.tools, []]) {
  const form = tools.length ? 'tool-bearing canonical stream' : 'plain stream progress fallback';
  test(`V0.29.83 disabled banner suppresses only greeting, not model SSE and session status: ${form}`, async (t) => {
    const upstreamBodies = [];
    const logs = [];
    const backend = http.createServer(async (req, res) => {
      upstreamBodies.push(await read(req));
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(responseEvents());
    });
    const baseUrl = await listen(backend);
    t.after(() => backend.close());
    const proxy = createProxyServer({
      ...loadConfig({ VLLM_BASE_URL: baseUrl, VLLM_BASE_MODEL: 'backend-model', PROXY_STARTUP_BANNER_ENABLED: 'false', PROXY_RUNTIME_TIME_ENABLED: 'false' }),
      host: '127.0.0.1', port: 0, progressVisibleAfterMs: 0,
      logLevel: 'info', logSink: (entry) => logs.push(entry),
    });
    const proxyUrl = await listen(proxy);
    t.after(() => proxy.close());

    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${proxyUrl}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': `v02983-${form}` },
        body: JSON.stringify({ ...payload, tools }),
      });
      const wire = await response.text();
      assert.equal(response.status, 200, wire);
      assert.match(wire, /READY/);
      assert.match(wire, /event: message_start/);
      assert.match(wire, /event: ping/);
      assert.match(wire, /Processing/);
      assert.match(wire, /event: message_stop/);
      assert.doesNotMatch(wire, /╭─◆ CC TOOL PROXY|VERSION\s+0\.29\./);
    }
    assert.equal(upstreamBodies.length, 2);
    assert.doesNotMatch(JSON.stringify(upstreamBodies), /CC TOOL PROXY|startup_banner/);
    assert.equal(logs.filter((entry) => entry.event === 'startup_banner_sent').length, 0);
    assert.equal(logs.filter((entry) => entry.event === 'startup_banner_committed').length, 0);
    assert.ok(logs.some((entry) => entry.event === 'startup_banner_skipped' && entry.reason === 'disabled_by_config'));

    const healthResponse = await fetch(`${proxyUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).service, 'proxy');
    const statusResponse = await fetch(`${proxyUrl}/cc-tool-proxy/status/${encodeURIComponent(`v02983-${form}`)}`);
    assert.equal(statusResponse.status, 200);
    assert.match((await statusResponse.json()).version, /^0\.29\./);
  });
}
