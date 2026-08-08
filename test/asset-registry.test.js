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

test('V0.2.26 registry composes nested crops back to root coordinates and registers derived assets', () => {
  const registry = new VisualAssetRegistry({ maxCropRounds: 3, maxCropsPerAsset: 8, maxDepth: 3 });
  const root = registry.add({
    buffer: Buffer.from('overview'), mediaType: 'image/png', width: 1000, height: 500,
    originalBuffer: Buffer.from('original'), originalMediaType: 'image/png', originalWidth: 2000, originalHeight: 1000,
    label: 'root', sourceKind: 'image',
  });
  const firstAuth = registry.authorizeCrop(root.sourceId, [100, 100, 900, 900], 1);
  assert.deepEqual(firstAuth.rootBox, [100, 100, 900, 900]);
  assert.deepEqual(firstAuth.rootPixelBox, { left: 200, top: 100, width: 1600, height: 800 });
  assert.equal(firstAuth.depth, 1);
  const first = registry.registerCrop(root.sourceId, {
    buffer: Buffer.from('crop1'), mediaType: 'image/png', width: 1600, height: 800,
  }, firstAuth, { purpose: 'first' });
  assert.equal(first.sourceId, 'asset-2');
  assert.equal(first.rootSourceId, root.sourceId);
  assert.equal(first.parentSourceId, root.sourceId);
  assert.equal(first.depth, 1);

  const secondAuth = registry.authorizeCrop(first.sourceId, [250, 250, 750, 750], 2);
  assert.deepEqual(secondAuth.rootBox, [300, 300, 700, 700]);
  assert.deepEqual(secondAuth.rootPixelBox, { left: 600, top: 300, width: 800, height: 400 });
  assert.equal(secondAuth.depth, 2);
  const second = registry.registerCrop(first.sourceId, {
    buffer: Buffer.from('crop2'), mediaType: 'image/png', width: 800, height: 400,
  }, secondAuth, { purpose: 'second' });
  assert.equal(second.rootSourceId, root.sourceId);
  assert.equal(second.parentSourceId, first.sourceId);
  assert.equal(second.depth, 2);
  assert.deepEqual(second.rootBox, [300, 300, 700, 700]);
});
