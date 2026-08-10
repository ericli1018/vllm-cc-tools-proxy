import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBaseLanguageRepairRequest,
  extractLanguageRepairSegmentFromAnthropic,
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

function processor(url) {
  return {
    enabled: true,
    provider: 'ollama',
    url,
    model: 'hf.co/unsloth/GLM-4.6V-Flash-GGUF:UD-Q8_K_XL',
    apiKey: 'x',
    think: false,
    timeoutMs: 5000,
  };
}

test('V0.2.28.6 external language processor translates one segment as plain text without marker protocol', async (t) => {
  let observed = null;
  const events = [];
  const backend = await listen(async (req, res) => {
    observed = JSON.parse(await read(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '經典 Pac-Man 遊戲已完成。' } }],
    }));
  });
  t.after(() => backend.server.close());

  const result = await rewriteFinalSegmentsWithExternalProcessor(['The classic Pac-Man game is complete.'], {
    locale: 'zh-TW',
    processor: processor(backend.url),
    onEvent: async (event, fields) => events.push({ event, ...fields }),
  });

  assert.deepEqual(result, ['經典 Pac-Man 遊戲已完成。']);
  assert.equal(observed.model, 'hf.co/unsloth/GLM-4.6V-Flash-GGUF:UD-Q8_K_XL');
  assert.equal(observed.stream, false);
  assert.equal(observed.reasoning_effort, 'none');
  assert.equal(observed.chat_template_kwargs, undefined);
  assert.equal(observed.tools, undefined);
  assert.equal(observed.messages.length, 2);
  assert.doesNotMatch(observed.messages[1].content, /VCC_LANG_SEGMENT/);
  assert.match(observed.messages[1].content, /The classic Pac-Man game is complete\./);
  assert.ok(events.some((entry) => entry.event === 'final_language_processor_request'
    && entry.segment_index === 0
    && entry.segment_count === 1
    && entry.input_chars === 'The classic Pac-Man game is complete.'.length));
  assert.ok(events.some((entry) => entry.event === 'final_language_processor_response'
    && entry.segment_index === 0
    && entry.segment_count === 1
    && entry.output_chars === '經典 Pac-Man 遊戲已完成。'.length));
});

test('V0.2.28.6 external processor translates multiple segments with one request per segment in source order', async (t) => {
  const observed = [];
  const translations = ['第一段。', '第二段。'];
  const backend = await listen(async (req, res) => {
    observed.push(JSON.parse(await read(req)));
    const index = observed.length - 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: translations[index] } }] }));
  });
  t.after(() => backend.server.close());

  const result = await rewriteFinalSegmentsWithExternalProcessor(['First.', 'Second.'], {
    locale: 'zh-TW', processor: processor(backend.url),
  });

  assert.deepEqual(result, translations);
  assert.equal(observed.length, 2);
  assert.match(observed[0].messages[1].content, /First\./);
  assert.doesNotMatch(observed[0].messages[1].content, /Second\./);
  assert.match(observed[1].messages[1].content, /Second\./);
  assert.doesNotMatch(observed[1].messages[1].content, /First\./);
  assert.doesNotMatch(JSON.stringify(observed), /VCC_LANG_SEGMENT/);
});

test('V0.2.28.6 external processor rejects a tool call instead of treating it as translated content', async (t) => {
  const backend = await listen(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'noop', arguments: '{}' } }] } }] }));
  });
  t.after(() => backend.server.close());

  await assert.rejects(
    () => rewriteFinalSegmentsWithExternalProcessor(['English answer.'], {
      locale: 'zh-TW', processor: processor(backend.url),
    }),
    (error) => error?.code === 'tool_call',
  );
});

test('V0.2.28.6 external processor is unavailable when the shared processor model is not configured', async () => {
  await assert.rejects(
    () => rewriteFinalSegmentsWithExternalProcessor(['English answer.'], {
      locale: 'zh-TW', processor: { enabled: true, url: 'http://127.0.0.1:1/v1/chat/completions', model: '' },
    }),
    (error) => error?.code === 'language_processor_unavailable',
  );
});

test('V0.2.28.6 Base language repair request is one isolated plain-text segment with no marker protocol', () => {
  const request = buildBaseLanguageRepairRequest('The answer is complete. Use `vllm serve`.', {
    locale: 'zh-TW', model: 'laguna', maxTokens: 4096,
  });
  assert.equal(request.model, 'laguna');
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 4096);
  assert.equal(request.tools, undefined);
  assert.equal(request.tool_choice, undefined);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.match(request.messages[0].content, /The answer is complete\. Use `vllm serve`\./);
  assert.doesNotMatch(request.messages[0].content, /VCC_LANG_SEGMENT/);
  assert.doesNotMatch(JSON.stringify(request), /Claude Code runtime instructions/);
  assert.equal(request.chat_template_kwargs.enable_thinking, false);
  assert.equal(request.chat_template_kwargs.preserve_thinking, false);
});

test('V0.2.28.6 Base repair accepts direct visible text and rejects tool calls or empty content', () => {
  assert.equal(extractLanguageRepairSegmentFromAnthropic({
    content: [{ type: 'text', text: '繁體中文。' }],
  }), '繁體中文。');

  assert.throws(() => extractLanguageRepairSegmentFromAnthropic({
    content: [{ type: 'tool_use', id: 'x', name: 'WebSearch', input: {} }],
  }), /tool call/i);

  assert.throws(() => extractLanguageRepairSegmentFromAnthropic({ content: [] }), /no visible text/i);
});
