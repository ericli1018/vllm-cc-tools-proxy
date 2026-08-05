import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualAssetRegistry } from '../src/visual/asset-registry.js';

test('registry assigns stable request-scoped ids and rejects unknown assets', () => {
  const registry = new VisualAssetRegistry();
  const asset = registry.add({ buffer: Buffer.from('x'), mediaType: 'image/png', width: 100, height: 50, label: 'page 1' });
  assert.equal(asset.sourceId, 'asset-1');
  assert.equal(registry.get('asset-1').label, 'page 1');
  assert.throws(() => registry.get('asset-9'), /Unknown visual source/);
});

test('registry validates normalized crop coordinates and bounded rounds', () => {
  const registry = new VisualAssetRegistry({ maxCropRounds: 2, maxCropsPerAsset: 6 });
  const asset = registry.add({ buffer: Buffer.from('x'), mediaType: 'image/png', width: 1000, height: 500 });
  const crop = registry.authorizeCrop(asset.sourceId, [100, 200, 900, 800], 1);
  assert.deepEqual(crop.pixelBox, { left: 100, top: 100, width: 800, height: 300 });
  assert.throws(() => registry.authorizeCrop(asset.sourceId, [100, 100, 100, 500], 1), /Invalid crop/);
  assert.throws(() => registry.authorizeCrop(asset.sourceId, [0, 0, 1000, 1000], 3), /crop round limit/);
});
