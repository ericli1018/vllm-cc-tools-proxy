import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compressContinuationWindow } from '../src/services/continuation-state-compressor.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1/chat/completions` };
}

async function read(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

const validState = {
  working_assumptions: ['The model was planning a pure C game.'],
  decisions_considered: ['Use a console game loop.'],
  rejected_options: ['Do not use ncurses.'],
  unresolved_items: ['Ghost movement remains open.'],
  intended_next_actions: ['Create the project files.'],
};

test('V0.2.28.5 external continuation compressor sends one tool-less non-thinking model-state request', async (t) => {
  let observed = null;
  const backend = await listen(async (req, res) => {
    observed = JSON.parse(await read(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(validState) } }] }));
  });
  t.after(() => backend.server.close());

  const result = await compressContinuationWindow({
    text: 'MODEL-WORKING-STATE-ONLY', contextStart: 20000, contextEnd: 44000, index: 2,
  }, {
    processor: {
      enabled: true, provider: 'ollama', url: backend.url, model: 'aux-model', apiKey: 'x', think: false, timeoutMs: 5000,
    },
  });

  assert.deepEqual(result, validState);
  assert.equal(observed.model, 'aux-model');
  assert.equal(observed.stream, false);
  assert.equal(observed.reasoning_effort, 'none');
  assert.equal(observed.tools, undefined);
  assert.equal(observed.tool_choice, undefined);
  assert.match(observed.messages[1].content, /MODEL-WORKING-STATE-ONLY/);
  assert.match(observed.messages[1].content, /20000/);
  assert.doesNotMatch(JSON.stringify(observed), /tool_result|tool_use/);
});

test('V0.2.28.5 continuation compressor rejects model tool calls', async (t) => {
  const backend = await listen(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'Read', arguments: '{}' } }] } }] }));
  });
  t.after(() => backend.server.close());

  await assert.rejects(() => compressContinuationWindow({ text: 'state', contextStart: 0, contextEnd: 5, index: 1 }, {
    processor: { enabled: true, provider: 'vllm', url: backend.url, model: 'aux', timeoutMs: 5000 },
  }), (error) => error?.code === 'tool_call');
});

test('V0.2.28.5 continuation compressor rejects malformed schema', async (t) => {
  const backend = await listen(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ confirmed_facts: ['not allowed'] }) } }] }));
  });
  t.after(() => backend.server.close());

  await assert.rejects(() => compressContinuationWindow({ text: 'state', contextStart: 0, contextEnd: 5, index: 1 }, {
    processor: { enabled: true, provider: 'vllm', url: backend.url, model: 'aux', timeoutMs: 5000 },
  }), (error) => error?.code === 'invalid_continuation_state');
});
