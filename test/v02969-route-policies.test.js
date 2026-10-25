import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { resolveModelRoute } from '../src/proxy/model-router.js';
import { parsePdf } from '../src/parsers/pdf.js';
import { adaptMessages } from '../src/proxy/content-blocks.js';
import { toOpenAIRequest } from '../src/services/openai-upstream-adapter.js';

const base = { VLLM_BASE_URL: 'http://base:8000', VLLM_BASE_MODEL: 'fallback' };
const entry = { url: 'http://route:8000/v1', protocol: 'anthropic', model: 'routed' };
const configFor = extra => loadConfig({ ...base, VLLM_MODEL_ROUTES: JSON.stringify({ alias: { ...entry, ...extra } }) });
const limits = { maxDecodedBytes: 10 * 1024 * 1024, maxRequestBytes: 20 * 1024 * 1024, maxPdfPages: 20, maxOutputChars: 100000, processTimeoutMs: 20000, nativeTextMinCharsPerPage: 80, maxImagePixels: 20_000_000, maxVisualPagesPerBatch: 4 };

test('V0.29.69 route policy booleans default true and preserve explicit false independently', () => {
  const route = resolveModelRoute('alias', configFor({}));
  assert.equal(route.compactUseRoute, true);
  assert.equal(route.visualUseRoute, true);
  assert.equal(route.visionEnabled, undefined);
  for (const compact of [true, false]) for (const visual of [true, false]) {
    const selected = resolveModelRoute('alias', configFor({ compact_use_route: compact, visual_use_route: visual, vision_enabled: false }));
    assert.equal(selected.compactUseRoute, compact);
    assert.equal(selected.visualUseRoute, visual);
    assert.equal(selected.visionEnabled, false);
    assert.ok(Object.isFrozen(selected));
  }
});

test('V0.29.69 route policy fields require JSON booleans, never string coercion', () => {
  for (const key of ['compact_use_route', 'visual_use_route', 'vision_enabled']) {
    for (const value of ['false', 'YES', 'NO', 0, 1, null, [], {}]) {
      assert.throws(() => configFor({ [key]: value }), new RegExp(key));
    }
  }
});

test('V0.29.69 route file preserves fields and ENV still takes priority', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'route69-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'routes.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, routes: { alias: { ...entry, visual_use_route: false, compact_use_route: false } } }));
  const fileConfig = loadConfig({ ...base, VLLM_MODEL_ROUTING_FILE: file });
  assert.equal(resolveModelRoute('alias', fileConfig).visualUseRoute, false);
  assert.equal(resolveModelRoute('alias', fileConfig).compactUseRoute, false);
  const envConfig = loadConfig({ ...base, VLLM_MODEL_ROUTING_FILE: file, VLLM_MODEL_ROUTES: JSON.stringify({ alias: entry }) });
  assert.equal(resolveModelRoute('alias', envConfig).visualUseRoute, true);
});

test('V0.29.69 one PDF block may expand to text and images without nesting content arrays', async () => {
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'fake' } };
  const parts = [{ type: 'text', text: 'Page 1' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }];
  const messages = [{ role: 'user', content: [doc, { type: 'tool_result', tool_use_id: 'read', content: [doc] }] }];
  const out = await adaptMessages(messages, { adaptDocument: async () => structuredClone(parts) });
  assert.deepEqual(out[0].content.slice(0, 2), parts);
  assert.deepEqual(out[0].content[2].content, parts);
  assert.equal(out[0].content[2].tool_use_id, 'read');
});

test('V0.29.69 OpenAI Read images survive after all parallel tool results with source ID and page label', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } };
  const request = toOpenAIRequest({ model: 'routed', messages: [
    { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'Read', input: {} })) },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'PDF page 42' }, image] },
      { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'PDF page 43' }, image] },
    ] },
  ] });
  assert.deepEqual(request.messages.map(m => m.role), ['assistant', 'tool', 'tool', 'user']);
  assert.equal(request.messages[1].tool_call_id, 'a');
  assert.equal(request.messages[2].tool_call_id, 'b');
  assert.equal(request.messages[3].content.filter(b => b.type === 'image_url').length, 2);
  assert.match(JSON.stringify(request.messages[3]), /PDF page 42/);
  assert.match(JSON.stringify(request.messages[3]), /PDF page 43/);
});

for (const name of ['text.pdf', 'scanned.pdf']) test(`V0.29.69 native PDF ${name}: local extraction and pages, no semantic inference`, async () => {
  const pdf = await fs.readFile(new URL(`./fixtures/${name}`, import.meta.url));
  const events = [];
  const result = await parsePdf(pdf, { limits, nativePages: true,
    onProgress: async (_message, details) => events.push(details),
    classifyPage: async () => assert.fail('native mode cannot classify through a model'),
    analyzeVisualAssets: async () => assert.fail('native mode cannot invoke dedicated Vision'),
  });
  assert.equal(result.native_pages.length, 1);
  assert.equal(result.native_pages[0].page, 1);
  assert.equal(result.native_pages[0].image.source.media_type, 'image/png');
  assert.equal(result.visual_used, false);
  assert.equal(result.classification_count, 0);
  assert.ok(events.some(e => e.phase === 'pdf_visual_prepare' && e.page === 1));
  assert.doesNotMatch(JSON.stringify(result), /\/tmp\/vllm-cc-pdf/);
});

async function pdfRunner(total, { text = '', onRender = () => {} } = {}) {
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  return async (command, args) => {
    if (command === 'pdfinfo') return { stdout: Buffer.from(`Pages: ${total}\nEncrypted: no\n`), stderr: Buffer.alloc(0) };
    if (command === 'pdftotext') return { stdout: Buffer.from(text), stderr: Buffer.alloc(0) };
    if (command === 'pdftoppm') { onRender(Number(args[1])); await fs.writeFile(`${args.at(-1)}.png`, png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (command === 'identify') return { stdout: Buffer.from('600 180'), stderr: Buffer.alloc(0) };
    if (command === 'convert') { await fs.writeFile(args.at(-1), png); return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    assert.fail(`unexpected ${command}`);
  };
}

test('V0.29.69 native large PDF retains document map and never renders unrequested pages', async () => {
  const input = Buffer.from('%PDF-1.4 test');
  const result = await parsePdf(input, { limits, nativePages: true, runner: await pdfRunner(100, { text: 'Heading', onRender: () => assert.fail('map cannot render pages') }) });
  assert.equal(result.document_mode, 'map'); assert.equal(result.visual_used, false); assert.equal(result.native_pages, undefined);
});

test('V0.29.69 native Read.pages preserves full-source and subset-source logical page numbers', async () => {
  for (const total of [50, 2]) {
    const rendered = [];
    const result = await parsePdf(Buffer.from('%PDF-1.4 test'), { limits, nativePages: true, pageScope: { canonical: '42-43', pages: [42, 43] }, runner: await pdfRunner(total, { onRender: page => rendered.push(page) }) });
    assert.deepEqual(result.native_pages.map(p => p.page), [42, 43]);
    assert.deepEqual(rendered, total === 50 ? [42, 43] : [1, 2]);
    assert.equal(result.native_pages.length, 2);
  }
});

test('V0.29.69 native PDF enforces aggregate generated image bytes and cancellation', async () => {
  const input = Buffer.from('%PDF-1.4 test');
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const runner = await pdfRunner(2);
  await assert.rejects(() => parsePdf(input, { limits: { ...limits, maxDecodedBytes: png.length + 1 }, nativePages: true, runner }), e => e.code === 'pdf_native_image_limit');
  const controller = new AbortController();
  const abortRunner = await pdfRunner(2, { onRender: () => controller.abort() });
  await assert.rejects(() => parsePdf(input, { limits, nativePages: true, runner: abortRunner, signal: controller.signal }), e => e.name === 'AbortError');
});

test('V0.29.69 native PDF observes a smaller remaining request-level image budget', async () => {
  const runner = await pdfRunner(1);
  await assert.rejects(() => parsePdf(Buffer.from('%PDF-1.4 test'), { limits, nativePages: true, maxNativeImageBytes: 1, runner }), e => e.code === 'pdf_native_image_limit');
});

test('V0.29.69 native image budget is shared across PDF documents within one request', async () => {
  const { createMediaAdapters } = await import('../src/proxy/media-adapters.js');
  const budgets = [];
  const png = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const pdf = await fs.readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const adapters = createMediaAdapters({ limits, nativePdfPassthrough: true }, undefined, undefined, {
    parsePdf: async (_buffer, options) => {
      budgets.push(options.maxNativeImageBytes);
      return { parser: 'test', page_count: 1, processed_pages: 1, markdown: '', native_pages: [{ page: 1, image: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } } }] };
    },
  });
  const block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } };
  await adapters.adaptDocument(block); await adapters.adaptDocument(block);
  assert.deepEqual(budgets, [limits.maxDecodedBytes, limits.maxDecodedBytes - png.length]);
});
