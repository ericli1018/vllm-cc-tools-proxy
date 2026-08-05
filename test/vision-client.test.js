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
    const payload = await read(req); requests.push(payload);
    const message = requests.length === 1
      ? { content: '', tool_calls: [{ id: 'crop-1', type: 'function', function: { name: 'request_image_crop', arguments: JSON.stringify({ source_id: 'asset-1', bbox: [100,100,800,800], purpose: 'read labels' }) } }] }
      : { content: '## Visual result\nLabels are readable.', tool_calls: [] };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const url = await listen(server); t.after(() => server.close());
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('image'), mediaType: 'image/png', width: 1000, height: 1000, label: 'image' });
  const crops = [];
  const result = await analyzeVisualAssets([asset], {
    baseUrl: url, model: 'vision-model', apiKey: 'vision-key', registry,
    cropImage: async (_asset, authorization) => { crops.push(authorization); return { buffer: Buffer.from('crop'), mediaType: 'image/png', width: 700, height: 700 }; },
  });
  assert.match(result.markdown, /Visual result/);
  assert.equal(crops.length, 1);
  assert.equal(requests[0].parallel_tool_calls, false);
  assert.equal(requests[0].tools[0].function.name, 'request_image_crop');
  assert.equal(requests[1].messages.some((m) => m.role === 'user' && Array.isArray(m.content)), true);
});
