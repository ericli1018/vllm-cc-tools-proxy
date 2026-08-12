import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { analyzeVisualAssets } from '../src/visual/vision-client.js';
import { VisualAssetRegistry } from '../src/visual/asset-registry.js';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function read(req) { const chunks=[]; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString()); }

test('vision client uses separate auth and executes a bounded crop request', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer vision-key');
    assert.equal(req.url, '/v1/chat/completions');
    const payload = await read(req); requests.push(payload);
    const message = requests.length === 1
      ? { content: '', tool_calls: [{ id: 'crop-1', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100,100,800,800], purpose: 'read labels' }) } }] }
      : { content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Labels are readable.', tool_calls: [] };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image' });
  const crops = [];
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'vision-model', apiKey: 'vision-key', provider: 'vllm', think: false, registry,
    cropImage: async (_asset, authorization) => { crops.push(authorization); return { buffer: Buffer.from('crop'), mediaType: 'image/png', width: 700, height: 700 }; },
  });
  assert.match(result.markdown, /Labels are readable\./);
  assert.equal(crops.length, 1);
  assert.equal(requests[0].parallel_tool_calls, false);
  assert.equal(requests[0].reasoning_effort, 'none');
  assert.equal(requests[0].chat_template_kwargs.enable_thinking, false);
  assert.equal(requests[0].tools[0].function.name, 'request_image_crop');
  assert.equal(requests[1].messages.some((m) => m.role === 'user' && Array.isArray(m.content)), true);
});


test('Ollama native vision requests carry think=false and native image messages', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/api/chat');
    const payload = await read(req); requests.push(payload);
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A red object is visible.', tool_calls: [] } }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 100, height: 100, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'hf.co/unsloth/GLM-4.6V-Flash-GGUF:UD-Q8_K_XL', provider: 'ollama', think: false, registry,
    cropImage: async () => { throw new Error('not expected'); },
  });
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A red object is visible.');
  assert.equal(requests[0].think, false);
  assert.doesNotMatch(requests[0].messages[0].content, /^\/nothink\b/);
  assert.equal(requests[0].messages[1].images.length, 1);
  assert.equal(typeof requests[0].messages[1].content, 'string');
  assert.equal('reasoning_effort' in requests[0], false);
});

test('invalid crop is returned to the visual model as a recoverable tool result', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const payload = await read(req); requests.push(payload);
    const message = requests.length === 1
      ? { content: '', tool_calls: [{ id: 'bad-crop', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100,100,105,105], purpose: 'tiny' }) } }] }
      : { content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Completed without the invalid crop.', tool_calls: [] };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image' });
  const progress = [];
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'vision-model', provider: 'vllm', think: false, registry,
    onProgress: async (message, details) => progress.push({ message, details }),
    cropImage: async () => { throw new Error('invalid crop must not reach image processor'); },
  });
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Completed without the invalid crop.');
  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.find((message) => message.role === 'tool');
  const content = JSON.parse(toolResult.content);
  assert.equal(content.ok, false);
  assert.equal(content.error.code, 'crop_region_too_small');
  assert.equal(content.error.retryable, true);
  assert.equal(progress.some((item) => item.message.includes('Invalid crop')), false);
  assert.equal(progress.some((item) => item.details.code === 'crop_region_too_small'), true);
});

test('crop recovery is bounded and finishes with tools disabled', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const payload = await read(req); requests.push(payload);
    const message = requests.length <= 2
      ? { content: '', tool_calls: [{ id: `bad-${requests.length}`, type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [0,0,1,1], purpose: 'tiny' }) } }] }
      : { content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Final answer from available evidence.', tool_calls: [] };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'vision-model', provider: 'vllm', think: true, registry, maxCropRounds: 2,
    cropImage: async () => { throw new Error('not expected'); },
  });
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Final answer from available evidence.');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].chat_template_kwargs.enable_thinking, true);
  assert.equal(requests[2].tools, undefined);
  assert.equal(requests[2].tool_choice, undefined);
});

test('Ollama crop tool arguments may be native objects and thinking remains internal', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const payload = await read(req); requests.push(payload);
    const message = requests.length === 1
      ? { thinking: 'private reasoning', content: '', tool_calls: [{ function: { name: 'request_image_crop', arguments: { source_id: 'asset-1', bbox: [100,100,900,900], purpose: 'native object' } } }] }
      : { thinking: 'more private reasoning', content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Native Ollama crop completed.', tool_calls: [] };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ message }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'qwen3.6:27b', provider: 'ollama', think: true, registry,
    cropImage: async () => ({ buffer: Buffer.from('crop'), mediaType: 'image/png', width: 800, height: 800 }),
  });
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Native Ollama crop completed.');
  assert.equal(requests[0].think, true);
  assert.equal(requests[1].messages.some((message) => message.role === 'assistant' && message.thinking === 'private reasoning'), true);
  assert.equal(requests[1].messages.some((message) => message.role === 'tool' && message.tool_name === 'request_image_crop'), true);
  assert.equal(result.markdown.includes('private reasoning'), false);
});

test('mixed valid and invalid crop calls continue without a top-level error', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const payload = await read(req); requests.push(payload);
    const message = requests.length === 1
      ? { content: '', tool_calls: [
          { id: 'good', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100,100,900,900], purpose: 'good' }) } },
          { id: 'bad', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100,100,101,101], purpose: 'bad' }) } },
        ] }
      : { content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Completed with the valid crop.', tool_calls: [] };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'vision', provider: 'vllm', think: false, registry,
    cropImage: async () => ({ buffer: Buffer.from('crop'), mediaType: 'image/png', width: 800, height: 800 }),
  });
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Completed with the valid crop.');
  assert.equal(result.cropCount, 1);
  const toolMessages = requests[1].messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
  assert.deepEqual(toolMessages.map((item) => item.ok), [true, false]);
});

test('unexpected proxy programming errors are not hidden as crop validation failures', async (t) => {
  const server = http.createServer(async (_req, res) => {
    const message = { content: '', tool_calls: [{ id: 'crop', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100,100,900,900], purpose: 'trigger' }) } }] };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image' });
  await assert.rejects(() => analyzeVisualAssets([asset], {
    baseUrl: url, model: 'vision', provider: 'vllm', think: false, registry,
    cropImage: async () => { throw new TypeError('programming defect'); },
  }), /programming defect/);
});

test('visual worker prompt forbids protocol markup and reports control tags without exposing content', async (t) => {
  let observed;
  const diagnostics = [];
  const server = http.createServer(async (req, res) => {
    observed = await read(req);
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- text </function_result> <tool_call>', tool_calls: [] } }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 100, height: 100, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'qwen3.6:27b', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });
  assert.match(observed.messages[0].content, /Return Markdown only/i);
  assert.match(observed.messages[0].content, /Do not emit.*tool-call/i);
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- text </function_result> <tool_call>');
  assert.ok(diagnostics.some((entry) => entry.event === 'visual_control_tags_detected'
    && entry.details.tagCount === 2
    && entry.details.tags.includes('function_result')
    && entry.details.tags.includes('tool_call')));
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_observed'
    && entry.details.usable_content === true));
});

test('V0.2.26 Vision worker can crop a crop using the registered derived source id', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const payload = await read(req); requests.push(payload);
    let message;
    if (requests.length === 1) {
      message = { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100,100,900,900], purpose: 'first zoom' }) } }] };
    } else if (requests.length === 2) {
      assert.match(JSON.stringify(payload.messages), /source_id=asset-2/);
      message = { content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-2', bbox: [250,250,750,750], purpose: 'second zoom' }) } }] };
    } else {
      assert.match(JSON.stringify(payload.messages), /source_id=asset-3/);
      message = { content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Nested crop analysis complete.', tool_calls: [] };
    }
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({
    buffer: Buffer.from('overview'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image',
    originalBuffer: Buffer.from('original'), originalMediaType: 'image/png', originalWidth: 2000, originalHeight: 2000,
  });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'vision', provider: 'vllm', think: false, registry, maxCropRounds: 3,
    cropImage: async (_source, authorization) => ({
      buffer: Buffer.from(`crop-${authorization.depth}`), mediaType: 'image/png',
      width: authorization.rootPixelBox.width, height: authorization.rootPixelBox.height,
    }),
  });
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Nested crop analysis complete.');
  assert.equal(result.cropCount, 2);
  assert.equal(requests.length, 3);
  assert.equal(registry.get('asset-3').depth, 2);
});

test('V0.2.26 Vision diagnostics expose safe Ollama backend routing and timing without image bytes', async (t) => {
  const events = [];
  const server = http.createServer(async (req, res) => {
    await read(req);
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A blue square is visible.', tool_calls: [] } }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('secret-image-bytes'), mediaType: 'image/png', width: 640, height: 480, label: 'photo' });
  await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'qwen-vision', provider: 'ollama', think: false, registry,
    onEvent: (event, fields) => events.push({ event, fields }),
    cropImage: async () => { throw new Error('not expected'); },
  });
  const request = events.find((entry) => entry.event === 'vision_upstream_request');
  const response = events.find((entry) => entry.event === 'vision_upstream_response');
  assert.ok(request);
  assert.equal(request.fields.provider, 'ollama');
  assert.equal(request.fields.backend_host, new URL(url).host);
  assert.equal(request.fields.endpoint_path, '/api/chat');
  assert.equal(request.fields.model, 'qwen-vision');
  assert.equal(request.fields.image_count, 1);
  assert.deepEqual(request.fields.dimensions, ['640x480']);
  assert.ok(response);
  assert.equal(response.fields.http_status, 200);
  assert.ok(Number.isFinite(response.fields.elapsed_ms));
  assert.equal(JSON.stringify(events).includes('secret-image-bytes'), false);
});

test('V0.2.27 classification-only Vision request omits crop tools', async (t) => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ROUTE: TEXT' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const root = registry.add({ buffer: Buffer.from('png'), mediaType: 'image/png', width: 10, height: 10 });
  const result = await analyzeVisualAssets([root], {
    baseUrl: 'http://vision.local', model: 'vision', registry,
    cropImage: async () => { throw new Error('crop must not run'); },
    allowCrops: false,
    outputContract: 'raw',
  });
  assert.match(result.markdown, /ROUTE: TEXT/);
  assert.equal('tools' in requests[0], false);
  assert.equal('tool_choice' in requests[0], false);
});

test('V0.2.28.1 strips native and inline Vision reasoning before producing evidence', async (t) => {
  const diagnostics = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: {
      role: 'assistant',
      thinking: 'native private reasoning',
      content: '<think>inline private reasoning</think>\nVISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Two characters are visible.',
      tool_calls: [],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 320, height: 240, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'hf.co/unsloth/GLM-4.6V-Flash-GGUF:UD-Q8_K_XL', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });

  assert.match(result.markdown, /VISUAL_STATUS: CONTENT[\s\S]*Two characters are visible\./);
  assert.equal(result.markdown.includes('inline private reasoning'), false);
  assert.equal(result.markdown.includes('native private reasoning'), false);
  assert.ok(diagnostics.some((entry) => entry.event === 'visual_control_tags_detected'
    && entry.details.tags.includes('think')));
  assert.ok(diagnostics.some((entry) => entry.event === 'visual_reasoning_stripped'
    && entry.details.native_thinking === true
    && entry.details.inline_think_regions === 1));
});


test('V0.2.28.2 retries one empty Vision output and accepts the next visible result', async (t) => {
  let calls = 0;
  const diagnostics = [];
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: { role: 'assistant', content: calls === 1 ? '' : 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Visible evidence after retry.', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 320, height: 240, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });
  assert.equal(calls, 2);
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Visible evidence after retry.');
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_observed' && entry.details.usable_content === false));
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_empty_output_retry'));
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_observed' && entry.details.usable_content === true));
});

test('V0.2.28.2 rejects persistent empty Vision output instead of returning cacheable fallback evidence', async (t) => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 320, height: 240, label: 'image' });
  await assert.rejects(() => analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    cropImage: async () => { throw new Error('not expected'); },
  }), (error) => error?.code === 'vision_empty_output');
  assert.equal(calls, 2);
});

test('V0.29.1 retries weak short Vision evidence without changing configured thinking mode and accepts recovered evidence', async (t) => {
  const requests = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const content = requests.length === 1
      ? 'Unable to view image.'
      : 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- Two anime-style characters are visible against a dark red and purple background with bright effects and title text near the upper-left area.';
    return new Response(JSON.stringify({ message: { role: 'assistant', content, thinking: requests.length === 2 ? 'private visual reasoning' : '', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1999, height: 1124, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].think, false);
  assert.equal(requests[1].think, false);
  assert.match(result.markdown, /two anime-style characters/i);
  assert.equal(result.markdown.includes('private visual reasoning'), false);
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_quality'
    && entry.details.quality === 'weak'
    && entry.details.reasons.includes('visual_status_missing')
    && entry.details.cacheable === false));
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_quality_retry'
    && entry.details.from_think === false
    && entry.details.to_think === false
    && entry.details.strict === true));
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_quality'
    && entry.details.quality === 'good'
    && entry.details.cacheable === true));
});

test('V0.29.1 rejects persistent weak Vision evidence without changing configured thinking mode', async (t) => {
  const requests = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Unable to view image.', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1999, height: 1124, label: 'image' });

  await assert.rejects(() => analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  }), (error) => error?.code === 'vision_output_invalid');

  assert.equal(requests.length, 2);
  assert.equal(requests[0].think, false);
  assert.equal(requests[1].think, false);
  assert.ok(diagnostics.filter((entry) => entry.event === 'vision_output_quality' && entry.details.quality === 'weak').length >= 2);
});

test('V0.29.1 quality recovery preserves configured think=false and reports strict retry progress', async (t) => {
  const requests = [];
  const progress = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const content = requests.length === 1 ? 'No useful details.' : 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A blue rectangular control panel is visible on the right side.';
    return new Response(JSON.stringify({ message: { role: 'assistant', content, tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'image' });

  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onProgress: (message, details) => progress.push({ message, details }),
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });

  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A blue rectangular control panel is visible on the right side.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].think, false);
  assert.equal(requests[1].think, false);
  assert.ok(progress.some((entry) => entry.details?.phase === 'vision_quality_retry'));
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_quality_retry'
    && entry.details.from_think === false
    && entry.details.to_think === false));
});

test('V0.29.1 Vision timeout uses explicit deadline and returns vision_service_timeout', async (t) => {
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('unexpected slow fallback'), { code: 'SLOW_FETCH' })), 120);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(options.signal.reason);
    }, { once: true });
  });
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'image' });
  const startedAt = Date.now();

  await assert.rejects(() => analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    timeoutMs: 25,
    cropImage: async () => { throw new Error('not expected'); },
  }), (error) => error?.code === 'vision_service_timeout' && error?.retryable === true);
  assert.ok(Date.now() - startedAt < 100, 'Vision deadline should abort before the slow fallback rejection');
});

test('V0.2.28.3 accepts concise concrete observable Vision evidence without adaptive retry', async (t) => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A red cat sits on a chair.', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    cropImage: async () => { throw new Error('not expected'); },
  });
  assert.equal(requests.length, 1);
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A red cat sits on a chair.');
});

test('V0.2.28.3 accepts concise Traditional Chinese observable evidence without recovery', async (t) => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- 紅色人物位於畫面左側。', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'image' });
  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    cropImage: async () => { throw new Error('not expected'); },
  });
  assert.equal(requests.length, 1);
  assert.equal(result.markdown, 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- 紅色人物位於畫面左側。');
});

test('V0.2.28.4 Vision failure diagnostic exposes safe transport cause without payload content', async (t) => {
  const events = [];
  globalThis.fetch = async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
    throw error;
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('secret-image-bytes'), mediaType: 'image/png', width: 1602, height: 2265, label: 'tile' });
  await assert.rejects(() => analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm', provider: 'ollama', registry,
    onEvent: (event, details) => events.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  }), (error) => error?.code === 'vision_service_error');
  const response = events.find((entry) => entry.event === 'vision_upstream_response');
  assert.equal(response?.details.transport_code, 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal(response?.details.transport_phase, 'headers');
  assert.equal(JSON.stringify(response).includes('secret-image-bytes'), false);
});

test('V0.29.2 accepts explicit BLANK Vision status as good cacheable evidence without retry', async (t) => {
  const requests = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'VISUAL_STATUS: BLANK', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'blank-page' });

  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });

  assert.equal(requests.length, 1);
  assert.equal(result.markdown, 'VISUAL_STATUS: BLANK');
  assert.match(requests[0].messages[0].content, /VISUAL_STATUS: CONTENT/);
  assert.match(requests[0].messages[0].content, /VISUAL_STATUS: BLANK/);
  assert.match(requests[0].messages[0].content, /VISUAL_STATUS: UNREADABLE/);
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_quality'
    && entry.details.quality === 'good'
    && entry.details.visual_status === 'blank'
    && entry.details.contract_valid === true
    && entry.details.cacheable === true));
});

test('V0.29.2 accepts concise CONTENT when explicit evidence contract is present and does not use too_short', async (t) => {
  const requests = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- LED.', tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'led' });

  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });

  assert.equal(requests.length, 1);
  assert.match(result.markdown, /- LED\./);
  const quality = diagnostics.find((entry) => entry.event === 'vision_output_quality')?.details;
  assert.equal(quality?.quality, 'good');
  assert.equal(quality?.visual_status, 'content');
  assert.equal(quality?.contract_valid, true);
  assert.equal(quality?.reasons.includes('too_short'), false);
});

test('V0.29.2 retries a final Vision response that omits VISUAL_STATUS and recovery prompt restates the contract', async (t) => {
  const requests = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const content = requests.length === 1
      ? 'A red LED is visible.'
      : 'VISUAL_STATUS: CONTENT\nVISUAL_EVIDENCE:\n- A red LED is visible.';
    return new Response(JSON.stringify({ message: { role: 'assistant', content, tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'led' });

  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });

  assert.equal(requests.length, 2);
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_quality'
    && entry.details.quality === 'weak'
    && entry.details.reasons.includes('visual_status_missing')
    && entry.details.contract_valid === false));
  const retryUserMessage = requests[1].messages.at(-1)?.content || '';
  assert.match(retryUserMessage, /VISUAL_STATUS: CONTENT \| BLANK \| UNREADABLE/);
  assert.match(retryUserMessage, /VISUAL_EVIDENCE:/);
  assert.match(result.markdown, /VISUAL_STATUS: CONTENT/);
});

test('V0.29.2 treats UNREADABLE as explicit weak evidence and CONTENT without evidence block as contract-invalid', async (t) => {
  const requests = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const content = requests.length === 1
      ? 'VISUAL_STATUS: UNREADABLE\nVISUAL_REASON: Labels are too small.'
      : 'VISUAL_STATUS: CONTENT';
    return new Response(JSON.stringify({ message: { role: 'assistant', content, tool_calls: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'labels' });

  await assert.rejects(() => analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'ollama', think: false, registry,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  }), (error) => error?.code === 'vision_output_invalid');

  assert.equal(requests.length, 2);
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_quality'
    && entry.details.reasons.includes('visual_status_unreadable')));
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_quality'
    && entry.details.reasons.includes('content_evidence_missing')));
});

test('V0.29.2 raw Vision mode bypasses VISUAL_STATUS contract for routing classifiers', async (t) => {
  const requests = [];
  const diagnostics = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ROUTE: TEXT' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 640, height: 480, label: 'classifier' });

  const result = await analyzeVisualAssets([asset], {
    baseUrl: 'http://vision.local', model: 'glm-4.6v-flash', provider: 'vllm', think: false, registry,
    allowCrops: false,
    outputContract: 'raw',
    prompt: 'Return ROUTE only.',
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    cropImage: async () => { throw new Error('not expected'); },
  });

  assert.equal(requests.length, 1);
  assert.equal(result.markdown, 'ROUTE: TEXT');
  assert.doesNotMatch(requests[0].messages[0].content, /VISUAL_STATUS:/);
  assert.ok(diagnostics.some((entry) => entry.event === 'vision_output_quality'
    && entry.details.output_contract === 'raw'
    && entry.details.quality === 'good'));
});
