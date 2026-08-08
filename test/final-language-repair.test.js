import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBaseLanguageRepairRequest,
  extractLanguageRepairSegmentsFromAnthropic,
  rewriteFinalSegmentsWithExternalProcessor,
} from '../src/services/final-language-repair.js';

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

test('V0.2.26.4 external language processor rewrites segments with one tool-less non-thinking request', async (t) => {
  let observed = null;
  const backend = await listen(async (req, res) => {
    observed = JSON.parse(await read(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '<<<VCC_LANG_SEGMENT_0>>>\n第一段。\n<<<VCC_LANG_SEGMENT_END_0>>>\n<<<VCC_LANG_SEGMENT_1>>>\n第二段。\n<<<VCC_LANG_SEGMENT_END_1>>>' } }],
    }));
  });
  t.after(() => backend.server.close());

  const result = await rewriteFinalSegmentsWithExternalProcessor(['First.', 'Second.'], {
    locale: 'zh-TW',
    processor: {
      enabled: true, provider: 'ollama', url: backend.url, model: 'qwen3.5:9b', apiKey: 'x', think: false, timeoutMs: 5000,
    },
  });

  assert.deepEqual(result, ['第一段。', '第二段。']);
  assert.equal(observed.model, 'qwen3.5:9b');
  assert.equal(observed.stream, false);
  assert.equal(observed.reasoning_effort, 'none');
  assert.equal(observed.tools, undefined);
  assert.equal(observed.messages.length, 2);
  assert.match(observed.messages[1].content, /<<<VCC_LANG_SEGMENT_0>>>/);
});

test('V0.2.26.4 external processor is unavailable when the shared processor model is not configured', async () => {
  await assert.rejects(
    () => rewriteFinalSegmentsWithExternalProcessor(['English answer.'], {
      locale: 'zh-TW', processor: { enabled: true, url: 'http://127.0.0.1:1/v1/chat/completions', model: '' },
    }),
    (error) => error?.code === 'language_processor_unavailable',
  );
});

test('V0.2.26.4 Base language repair request is isolated from the original Claude Code conversation', () => {
  const request = buildBaseLanguageRepairRequest(['The answer is complete.', 'Use `vllm serve`.'], {
    locale: 'zh-TW', model: 'laguna', maxTokens: 4096,
  });
  assert.equal(request.model, 'laguna');
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 4096);
  assert.equal(request.tools, undefined);
  assert.equal(request.tool_choice, undefined);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.match(request.messages[0].content, /<<<VCC_LANG_SEGMENT_0>>>/);
  assert.doesNotMatch(JSON.stringify(request), /Claude Code runtime instructions/);
  assert.equal(request.chat_template_kwargs.enable_thinking, false);
  assert.equal(request.chat_template_kwargs.preserve_thinking, false);
});

test('V0.2.26.4 Base repair parser accepts only visible text with the exact segment contract', () => {
  assert.deepEqual(extractLanguageRepairSegmentsFromAnthropic({
    content: [{ type: 'text', text: '<<<VCC_LANG_SEGMENT_0>>>\n繁體中文。\n<<<VCC_LANG_SEGMENT_END_0>>>' }],
  }, 1), ['繁體中文。']);

  assert.throws(() => extractLanguageRepairSegmentsFromAnthropic({
    content: [{ type: 'tool_use', id: 'x', name: 'WebSearch', input: {} }],
  }, 1), /tool call/i);
});
