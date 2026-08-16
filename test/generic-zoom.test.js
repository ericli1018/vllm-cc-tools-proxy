import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualAssetRegistry } from '../src/visual/asset-registry.js';
import { analyzeGenericZoomFallback } from '../src/visual/generic-zoom.js';

function rootAsset(registry) {
  return registry.add({
    buffer: Buffer.from('root'), mediaType: 'image/png', width: 1200, height: 800,
    originalBuffer: Buffer.from('root'), originalMediaType: 'image/png', originalWidth: 1200, originalHeight: 800,
  });
}

test('V0.29.26 generic deterministic zoom tiles do not consume model crop quota', async () => {
  const registry = new VisualAssetRegistry({ maxCropsPerRoot: 1 });
  const root = rootAsset(registry);
  const analyzed = [];
  const output = await analyzeGenericZoomFallback(root, {
    registry,
    cropImage: async (_asset, authorization) => ({
      buffer: Buffer.from(`tile-${authorization.rootBox.join('-')}`), mediaType: 'image/png',
      width: authorization.rootPixelBox.width, height: authorization.rootPixelBox.height,
    }),
    analyzeTile: async (asset, tile) => {
      analyzed.push({ asset, tile });
      return { markdown: `tile ${tile.index}`, warnings: [], needsZoom: false, cacheable: true };
    },
  });

  assert.equal(output.tileCount, 4);
  assert.equal(analyzed.length, 4, 'all deterministic tiles must be created even when model crop budget is one');
  assert.ok(analyzed.every(({ asset }) => asset.depth === 0));

  const firstModelCrop = registry.authorizeCrop(analyzed[0].asset.sourceId, [100, 100, 700, 700], 1);
  assert.equal(firstModelCrop.depth, 1, 'a precise model crop from a deterministic tile still starts at crop depth one');
  assert.throws(
    () => registry.authorizeCrop(analyzed[1].asset.sourceId, [100, 100, 700, 700], 1),
    (error) => error?.code === 'visual_crop_count_limit',
    'model-requested crops must still share the root safety quota',
  );
});

test('V0.29.26 crop budget exhaustion inside a generic zoom worker is partial evidence, not fatal', async () => {
  const registry = new VisualAssetRegistry({ maxCropsPerRoot: 8 });
  const root = rootAsset(registry);
  const progress = [];
  let calls = 0;

  const output = await analyzeGenericZoomFallback(root, {
    registry,
    cropImage: async (_asset, authorization) => ({
      buffer: Buffer.from(`tile-${authorization.rootBox.join('-')}`), mediaType: 'image/png',
      width: authorization.rootPixelBox.width, height: authorization.rootPixelBox.height,
    }),
    analyzeTile: async (_asset, tile) => {
      calls += 1;
      if (tile.index === 2) {
        const error = new Error('Visual crop count limit exceeded.');
        error.code = 'visual_crop_count_limit';
        throw error;
      }
      return { markdown: `tile ${tile.index} evidence`, warnings: [], needsZoom: false, cacheable: true };
    },
    onProgress: async (message, details) => progress.push({ message, details }),
  });

  assert.equal(calls, 4, 'remaining deterministic tiles must continue after one tile exhausts crop budget');
  assert.equal(output.failedCount, 1);
  assert.equal(output.terminalStatus, 'partial');
  assert.equal(output.cacheable, false);
  assert.match(output.markdown, /tile 1 evidence/i);
  assert.match(output.markdown, /zoom tile 2 unavailable \(visual_crop_count_limit\)/i);
  assert.ok(output.warnings.includes('vision_zoom_budget_exhausted:visual_crop_count_limit'));
  assert.ok(progress.some(({ details }) => details?.phase === 'image_zoom_budget_exhausted'));
});
