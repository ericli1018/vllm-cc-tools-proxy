import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { createProxyServer } from '../src/services/proxy-server.js';

async function listen(t, handler) {
  const server = handler instanceof http.Server ? handler : http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}
const anthropicMessage = (model, text = 'OK') => ({
  id: 'msg_backend', type: 'message', role: 'assistant', model,
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 3 },
});
const event = (name, payload) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
function anthropicSse(model, text = 'OK') {
  return event('message_start', { type: 'message_start', message: { ...anthropicMessage(model, ''), content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } })
    + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + event('content_block_stop', { type: 'content_block_stop', index: 0 })
    + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    + event('message_stop', { type: 'message_stop' });
}
const openAiJson = (model, text = 'OK') => ({
  id: 'chat_backend', object: 'chat.completion', model,
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
});
function openAiSse(model, text = 'OK') {
  const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'chat_backend', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return frame({ role: 'assistant', content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n';
}
function parseMessageStart(wire) {
  const match = /event: message_start\r?\ndata: (\{[^\n]+\})/.exec(wire);
  assert.ok(match, `missing message_start in ${wire.slice(0, 500)}`);
  return JSON.parse(match[1]);
}
async function fixture(t, { aliases = null, unknownModel = 'reject' } = {}) {
  const seen = [];
  const definitions = aliases || {
    'claude-opus-5-5': { protocol: 'openai', model: 'DeepSeek-V4.1-Flash-1017', key: 'deepseek-key' },
    'claude-sonnet-5': { protocol: 'anthropic', model: 'Qwen3.8-27B', key: 'qwen-key' },
  };
  const routes = {};
  for (const [alias, def] of Object.entries(definitions)) {
    const url = await listen(t, async (req, res) => {
      const body = await readJson(req);
      seen.push({ alias, protocol: def.protocol, path: req.url, body, headers: req.headers });
      const responseText = `backend=${def.model}; tool argument DeepSeek-V4.1-Flash-1017 must remain unchanged`;
      if (def.protocol === 'openai') {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(openAiSse(def.model, responseText));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(openAiJson(def.model, responseText)));
        }
      } else if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(anthropicSse(def.model, responseText));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicMessage(def.model, responseText)));
      }
    });
    routes[alias] = { url, protocol: def.protocol, model: def.model, api_key: def.key };
  }
  const baseUrl = await listen(t, async (req, res) => {
    const body = await readJson(req);
    seen.push({ alias: null, protocol: 'anthropic', path: req.url, body, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropicMessage('base-physical-model', 'BASE')));
  });
  const config = {
    ...loadConfig({
      VLLM_BASE_URL: baseUrl,
      VLLM_BASE_API_PROTOCOL: 'anthropic',
      VLLM_BASE_MODEL: 'base-physical-model',
      VLLM_BASE_API_KEY: 'base-key',
      VLLM_MODEL_ROUTES: JSON.stringify(routes),
      VLLM_MODEL_ROUTING_UNKNOWN_MODEL: unknownModel,
      COMPLETION_PROBE_ENABLED: 'false',
      PROXY_RUNTIME_TIME_ENABLED: 'false',
      LOG_LEVEL: 'error',
    }),
    usagePreflightEnabled: false,
    logSink: () => {},
  };
  const proxy = await listen(t, createProxyServer(config));
  const post = (model, { stream = false, managed = false } = {}) => fetch(`${proxy}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream, max_tokens: 128,
      messages: [{ role: 'user', content: 'reply once' }],
      ...(managed ? { tools: [{ name: 'WebSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }] } : {}),
    }),
  });
  return { seen, post };
}

for (const model of ['claude-opus-5-5', 'claude-sonnet-5']) {
  test(`V0.29.80 routed non-stream /v1/messages restores requested alias: ${model}`, async t => {
    const { seen, post } = await fixture(t);
    const response = await post(model);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, model);
    assert.match(payload.content[0].text, /DeepSeek-V4\.1-Flash-1017/);
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0].body.model, model);
    assert.equal(seen[0].body.model, model === 'claude-opus-5-5' ? 'DeepSeek-V4.1-Flash-1017' : 'Qwen3.8-27B');
  });
}

for (const model of ['claude-opus-5-5', 'claude-sonnet-5']) {
  test(`V0.29.80 routed SSE message_start keeps requested alias: ${model}`, async t => {
    const { seen, post } = await fixture(t);
    const response = await post(model, { stream: true });
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.equal(parseMessageStart(wire).message.model, model);
    assert.match(wire, /DeepSeek-V4\.1-Flash-1017/);
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0].body.model, model);
  });
}

for (const model of ['claude-opus-5-5', 'claude-sonnet-5']) {
  test(`V0.29.80 managed non-stream response restores requested alias: ${model}`, async t => {
    const { seen, post } = await fixture(t);
    const response = await post(model, { managed: true });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, model);
    assert.ok(seen.length >= 1);
    assert.ok(seen.every(call => call.body.model !== model));
  });
}

test('V0.29.80 concurrent routed aliases never cross response model names', async t => {
  const { post } = await fixture(t);
  const [opus, sonnet] = await Promise.all([
    post('claude-opus-5-5').then(r => r.json()),
    post('claude-sonnet-5').then(r => r.json()),
  ]);
  assert.equal(opus.model, 'claude-opus-5-5');
  assert.equal(sonnet.model, 'claude-sonnet-5');
});

test('V0.29.80 unknown-model Base fallback keeps legacy physical response model', async t => {
  const { post, seen } = await fixture(t, { unknownModel: 'fallback' });
  const response = await post('client-unknown');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.model, 'base-physical-model');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].alias, null);
});

test('V0.29.80 response model rewrite never changes tool arguments containing physical model names', async t => {
  const seen = [];
  const backendUrl = await listen(t, async (req, res) => {
    const body = await readJson(req);
    seen.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chat_tool', object: 'chat.completion', model: 'DeepSeek-V4.1-Flash-1017',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_model', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo DeepSeek-V4.1-Flash-1017', model: 'DeepSeek-V4.1-Flash-1017' }) } }],
      } }], usage: { prompt_tokens: 9, completion_tokens: 4 },
    }));
  });
  const config = {
    ...loadConfig({
      VLLM_BASE_URL: 'http://127.0.0.1:1/v1', VLLM_BASE_API_PROTOCOL: 'openai', VLLM_BASE_MODEL: 'unused',
      VLLM_MODEL_ROUTES: JSON.stringify({
        'claude-opus-5-5': { url: backendUrl, protocol: 'openai', model: 'DeepSeek-V4.1-Flash-1017' },
      }),
      COMPLETION_PROBE_ENABLED: 'false', PROXY_RUNTIME_TIME_ENABLED: 'false', LOG_LEVEL: 'error',
    }), usagePreflightEnabled: false, logSink: () => {},
  };
  const proxy = await listen(t, createProxyServer(config));
  const response = await fetch(`${proxy}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 64,
      messages: [{ role: 'user', content: 'run' }], tools: [{ name: 'Bash', input_schema: { type: 'object' } }] }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.model, 'claude-opus-5-5');
  assert.equal(payload.content[0].type, 'tool_use');
  assert.equal(payload.content[0].input.command, 'echo DeepSeek-V4.1-Flash-1017');
  assert.equal(payload.content[0].input.model, 'DeepSeek-V4.1-Flash-1017');
  assert.equal(seen[0].model, 'DeepSeek-V4.1-Flash-1017');
});
