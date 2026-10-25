import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { runManagedLoop } from '../src/proxy/managed-loop.js';
import { createProxyServer } from '../src/services/proxy-server.js';
import { loadConfig } from '../src/config.js';

function message(content, stopReason = 'end_turn') {
  return { id: 'msg', type: 'message', role: 'assistant', model: 'mock', content, stop_reason: stopReason, usage: { input_tokens: 4, output_tokens: 2 } };
}
const candidate = () => message([{ type: 'text', text: 'Completed original answer.' }]);
const decision = (value, remainingWork) => message([{ type: 'tool_use', id: 'decision-1', name: 'SubmitCompletionDecision', input: {
  decision: value, ...(remainingWork ? { remaining_work: remainingWork } : {}),
} }], 'tool_use');
const initial = { model: 'alias-main', messages: [{ role: 'user', content: 'Answer me.' }], tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }] };

function collect() {
  const events = [];
  return { events, onDiagnostic: (event, details) => events.push({ event, details }) };
}

test('v0.29.67 accepts authoritative decision tool and ignores incidental model text', async () => {
  const diag = collect();
  let calls = 0;
  const result = await runManagedLoop(initial, {
    upstream: async () => (++calls === 1 ? candidate() : message([
      { type: 'text', text: 'extra explanation, never for Claude Code' },
      decision('complete').content[0],
    ], 'tool_use')),
    executeTool: async () => assert.fail('must not run a tool'),
    completionProbeEnabled: true,
    onDiagnostic: diag.onDiagnostic,
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, candidate());
  assert.ok(diag.events.some(x => x.event === 'completion_probe_extra_text_ignored' && x.details.bytes > 0));
  assert.doesNotMatch(JSON.stringify(result), /extra explanation/);
});

test('v0.29.67 strict JSON decision works when backend ignores forced tool choice', async () => {
  let calls = 0;
  const diag = collect();
  const result = await runManagedLoop(initial, {
    upstream: async () => ++calls === 1 ? candidate() : message([{ type: 'text', text: '{"decision":"await_user"}' }]),
    executeTool: async () => assert.fail('probe cannot execute tools'),
    completionProbeEnabled: true,
    onDiagnostic: diag.onDiagnostic,
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, candidate());
  assert.ok(diag.events.some(x => x.event === 'completion_probe_json_accepted' && x.details.retry_attempt === 0));
  assert.ok(diag.events.some(x => x.event === 'completion_probe_confirmed_final' && x.details.decision === 'await_user'));
});

test('v0.29.67 malformed text triggers distinct bounded JSON retry, then confirms completion', async () => {
  const seen = [];
  const diag = collect();
  const result = await runManagedLoop(initial, {
    upstream: async request => {
      seen.push(structuredClone(request));
      if (seen.length === 1) return candidate();
      if (seen.length === 2) return message([{ type: 'text', text: 'Seems done' }]);
      assert.equal(request.tool_choice.type, 'none');
      assert.deepEqual(request.tools.map(x => x.name), ['SubmitCompletionDecision']);
      assert.match(JSON.stringify(request.messages.at(-1).content), /VCC_COMPLETION_DECISION_PROBE_JSON_RETRY_V1/);
      return message([{ type: 'text', text: '{"decision":"complete"}' }]);
    },
    executeTool: async () => assert.fail('probe cannot execute tools'),
    completionProbeEnabled: true,
    onDiagnostic: diag.onDiagnostic,
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(result, candidate());
  assert.ok(diag.events.some(x => x.event === 'completion_probe_failed' && x.details.retry_attempt === 0));
  assert.ok(diag.events.some(x => x.event === 'completion_probe_retry_started' && x.details.strategy === 'strict_json'));
  assert.equal(diag.events.some(x => x.event === 'completion_probe_fallback'), false);
});

test('v0.29.67 rejects free prose, extra JSON fields, and malformed decision; fallback keeps original candidate', async () => {
  for (const invalid of ['Looks complete to me.', '{"decision":"complete"}\nThat is my opinion.', '{"decision":"continue"}', '{"decision":"complete","unexpected":true}']) {
    const diag = collect();
    let calls = 0;
    const result = await runManagedLoop(initial, {
      upstream: async () => ++calls === 1 ? candidate() : message([{ type: 'text', text: invalid }]),
      executeTool: async () => assert.fail('invalid decision cannot trigger actions'),
      completionProbeEnabled: true,
      completionProbeMaxRetries: 0,
      onDiagnostic: diag.onDiagnostic,
    });
    assert.equal(calls, 2);
    assert.deepEqual(result, candidate());
    assert.ok(diag.events.some(x => x.event === 'completion_probe_fallback' && x.details.action === 'return_original_candidate'));
    // Diagnostic metadata must never include raw model text or user prompt.
    assert.doesNotMatch(JSON.stringify(diag.events), /Looks complete to me|That is my opinion|unexpected/);
  }
});

test('v0.29.67 probe timeout aborts only hidden verification and returns valid candidate', async () => {
  let aborted = false;
  const diag = collect();
  let calls = 0;
  const result = await runManagedLoop(initial, {
    upstream: async (_request, signal) => {
      if (++calls === 1) return candidate();
      return await new Promise((_resolve, reject) => {
        const onAbort = () => { aborted = true; reject(signal.reason); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    executeTool: async () => assert.fail('probe cannot execute tools'),
    completionProbeEnabled: true,
    completionProbeTimeoutMs: 20,
    completionProbeMaxRetries: 0,
    onDiagnostic: diag.onDiagnostic,
  });
  assert.equal(calls, 2);
  assert.ok(aborted);
  assert.deepEqual(result, candidate());
  assert.ok(diag.events.some(x => x.event === 'completion_probe_failed' && x.details.code === 'completion_probe_timeout'));
});

test('v0.29.67 true client cancellation is not mistaken for probe failure fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  const diag = collect();
  await assert.rejects(runManagedLoop(initial, {
    upstream: async () => {
      if (++calls === 1) return candidate();
      controller.abort(new Error('client disconnected'));
      throw controller.signal.reason;
    },
    executeTool: async () => ({}),
    completionProbeEnabled: true,
    signal: controller.signal,
    onDiagnostic: diag.onDiagnostic,
  }), /client disconnected/);
  assert.equal(diag.events.some(x => x.event === 'completion_probe_fallback'), false);
});

test('v0.29.67 strict JSON continue still resumes Main and never executes the decision tool', async () => {
  let calls = 0;
  const diag = collect();
  const completed = message([{ type: 'text', text: 'Now I actually completed the task.' }]);
  const result = await runManagedLoop(initial, {
    upstream: async request => {
      calls++;
      if (calls === 1) return message([{ type: 'text', text: 'I will finish that required operation.' }]);
      if (calls === 2) return message([{ type: 'text', text: '{"decision":"continue","remaining_work":"Perform the promised operation."}' }]);
      assert.deepEqual(request.tools, initial.tools);
      return completed;
    },
    executeTool: async () => assert.fail('decision tool is never executable'),
    completionProbeEnabled: true,
    onDiagnostic: diag.onDiagnostic,
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, completed);
  assert.ok(diag.events.some(x => x.event === 'completion_probe_continuation'));
});

test('v0.29.67 completion probe env validates tight retry/time/candidate budgets', () => {
  const base = { VLLM_BASE_URL: 'http://localhost:8000/v1' };
  const defaults = loadConfig(base);
  assert.equal(defaults.completionProbeEnabled, true);
  assert.equal(defaults.completionProbeMaxRetries, 1);
  assert.equal(defaults.completionProbeTimeoutMs, 30000);
  assert.equal(defaults.completionProbeMaxPerCandidate, 2);
  const tuned = loadConfig({ ...base, COMPLETION_PROBE_MAX_RETRIES: '0', COMPLETION_PROBE_TIMEOUT_MS: '45000', COMPLETION_PROBE_MAX_PER_CANDIDATE: '3' });
  assert.deepEqual([tuned.completionProbeMaxRetries, tuned.completionProbeTimeoutMs, tuned.completionProbeMaxPerCandidate], [0, 45000, 3]);
  for (const [key, value] of [['COMPLETION_PROBE_MAX_RETRIES', '-1'], ['COMPLETION_PROBE_MAX_RETRIES', '3'], ['COMPLETION_PROBE_TIMEOUT_MS', '999'], ['COMPLETION_PROBE_MAX_PER_CANDIDATE', '999']]) {
    assert.throws(() => loadConfig({ ...base, [key]: value }), new RegExp(key));
  }
});

async function serve(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function read(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}
function options() {
  return { host: '127.0.0.1', port: 0, vllmBaseUrl: 'http://127.0.0.1:1/v1', vllmBaseApiProtocol: 'openai',
    responseLanguage: 'en-US', logLevel: 'info', usagePreflightEnabled: false, completionProbeEnabled: true,
    completionProbeMaxRetries: 0, completionProbeTimeoutMs: 5000, completionProbeMaxPerCandidate: 2,
    limits: { maxRequestBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024, maxPdfPages: 10,
      maxOutputChars: 20000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80,
      maxImagePixels: 20000000, maxVisualPagesPerBatch: 4 }, concurrency: { visionLimit: 1 } };
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('v0.29.67 HTTP two routed OpenAI backends pin Main and Probe and isolate failures', async t => {
  const calls = [];
  const createBackend = async label => serve(async (req, res) => {
    const payload = await read(req);
    calls.push({ label, model: payload.model, key: req.headers.authorization, path: req.url, probe: Boolean(payload.tools?.some(x => x.function?.name === 'SubmitCompletionDecision')) });
    const content = payload.tools?.some(x => x.function?.name === 'SubmitCompletionDecision')
      ? 'I think it is done, but this is NOT strict JSON'
      : `Original answer from ${label}`;
    if (label === 'B') {
      // Real OpenAI SSE: verify the same failure from the user's streaming log.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'stream-B', model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ id: 'stream-B', model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
        + 'data: [DONE]\n\n');
    } else {
      // Buffered JSON fallback when upstream ignores stream:true.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `${label}-message`, model: payload.model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 10, completion_tokens: 6 } }));
    }
  });
  const a = await createBackend('A');
  const b = await createBackend('B');
  const cfg = options();
  const logs = [];
  cfg.logSink = x => logs.push(x);
  cfg.modelRouting = { enabled: true, unknownModel: 'reject', routes: {
    'alias-a': { url: `${a.url}/v1`, model: 'model-a', apiKey: 'key-a', protocol: 'openai', alias: 'alias-a' },
    'alias-b': { url: `${b.url}/v1`, model: 'model-b', apiKey: 'key-b', protocol: 'openai', alias: 'alias-b' },
  } };
  const proxy = await serve(createProxyServer(cfg).listeners('request')[0]);
  t.after(async () => { await close(proxy.server); await close(a.server); await close(b.server); });
  const send = async (alias, stream) => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: alias, stream, max_tokens: 128,
        messages: [{ role: 'user', content: 'answer the question' }],
        tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }] }),
    });
    return { status: res.status, output: stream ? await res.text() : (await res.json()).content.map(x => x.text || '').join('') };
  };
  const [ra, rb] = await Promise.all([send('alias-a', false), send('alias-b', true)]);
  assert.deepEqual([ra.status, rb.status], [200, 200]);
  assert.match(ra.output, /Original answer from A/);
  assert.match(rb.output, /Original answer from B/);
  assert.doesNotMatch(ra.output + rb.output, /I think it is done/);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.filter(x => x.label === 'A').map(x => [x.model, x.key, x.path, x.probe]), [
    ['model-a', 'Bearer key-a', '/v1/chat/completions', false],
    ['model-a', 'Bearer key-a', '/v1/chat/completions', true],
  ]);
  assert.deepEqual(calls.filter(x => x.label === 'B').map(x => [x.model, x.key, x.path, x.probe]), [
    ['model-b', 'Bearer key-b', '/v1/chat/completions', false],
    ['model-b', 'Bearer key-b', '/v1/chat/completions', true],
  ]);
  assert.ok(logs.some(x => x.event === 'completion_probe_fallback'));
  assert.ok(logs.some(x => x.event === 'base_model_selected' && x.source === 'model_route' && x.route_alias === 'alias-a'));
  assert.ok(logs.some(x => x.event === 'base_model_selected' && x.source === 'model_route' && x.route_alias === 'alias-b'));
});
