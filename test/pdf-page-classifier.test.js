import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPdfPage, parsePageClassification } from '../src/visual/pdf-page-classifier.js';

const asset = { sourceId: 'asset-1', buffer: Buffer.from('x'), mediaType: 'image/png', width: 800, height: 600 };

test('V0.2.27 page classifier accepts only the four routing classes', () => {
  assert.deepEqual(parsePageClassification('ROUTE: SCHEMATIC\nCONFIDENCE: 0.93\nREASON: dense electrical connectivity'), {
    route: 'SCHEMATIC', confidence: 0.93, reason: 'dense electrical connectivity',
  });
  assert.equal(parsePageClassification('ROUTE: FLOW_CHART').route, 'DENSE_PAGE');
  assert.equal(parsePageClassification('unparseable').route, 'DENSE_PAGE');
});

test('V0.2.27 page classifier disables crop tools and falls back conservatively', async () => {
  const calls = [];
  const result = await classifyPdfPage(asset, {
    analyzeVisualAssets: async (assets, options) => {
      calls.push({ assets, options });
      return { markdown: 'ROUTE: DIAGRAM\nCONFIDENCE: 0.8\nREASON: arrows and blocks' };
    },
  });
  assert.equal(result.route, 'DIAGRAM');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.allowCrops, false);
  assert.match(calls[0].options.prompt, /TEXT.*DIAGRAM.*SCHEMATIC.*DENSE_PAGE/s);
  assert.match(calls[0].options.prompt, /reference designators.*pins.*nets.*wires/is);
  assert.match(calls[0].options.prompt, /flow ?charts?.*screenshots?.*architecture.*not.*SCHEMATIC/is);
});
