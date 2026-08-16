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

test('V0.2.27 deterministic region preserves root lineage without consuming crop depth', () => {
  const registry = new VisualAssetRegistry();
  const root = registry.add({
    buffer: Buffer.from('root'), mediaType: 'image/png', width: 2000, height: 1000,
    sourceKind: 'pdf_page', sourceMetadata: { page: 9 },
  });
  const tile = registry.registerRegion(root.sourceId, {
    buffer: Buffer.from('tile'), mediaType: 'image/png', width: 1200, height: 700,
  }, { rootBox: [100, 200, 700, 800], label: 'tile 1', regionKind: 'schematic_tile' });
  assert.equal(tile.rootSourceId, root.sourceId);
  assert.equal(tile.parentSourceId, root.sourceId);
  assert.equal(tile.depth, 0);
  assert.deepEqual(tile.rootBox, [100, 200, 700, 800]);
  assert.equal(tile.regionKind, 'schematic_tile');

  const auth = registry.authorizeCrop(tile.sourceId, [250, 250, 750, 750], 1);
  assert.equal(auth.depth, 1);
  assert.deepEqual(auth.rootBox, [250, 350, 550, 650]);
});

test('V0.29.3 default crop depth is capped at two', () => {
  const registry = new VisualAssetRegistry();
  const root = registry.add({ buffer: Buffer.from('root'), mediaType: 'image/png', width: 1000, height: 1000 });
  const first = registry.authorizeCrop(root.sourceId, [100, 100, 500, 500], 1);
  const crop1 = registry.registerCrop(root.sourceId, { buffer: Buffer.from('c1'), mediaType: 'image/png', width: 400, height: 400 }, first);
  const second = registry.authorizeCrop(crop1.sourceId, [200, 200, 800, 800], 2);
  const crop2 = registry.registerCrop(crop1.sourceId, { buffer: Buffer.from('c2'), mediaType: 'image/png', width: 240, height: 240 }, second);
  assert.throws(() => registry.authorizeCrop(crop2.sourceId, [200, 200, 800, 800], 3), (error) => error?.code === 'visual_crop_depth_limit');
});

test('V0.29.26 deterministic region authorization preserves lineage without consuming crop depth or count', () => {
  const registry = new VisualAssetRegistry({ maxCropsPerRoot: 1, maxDepth: 2 });
  const root = registry.add({
    buffer: Buffer.from('root'), mediaType: 'image/png', width: 1000, height: 500,
    originalBuffer: Buffer.from('original'), originalMediaType: 'image/png', originalWidth: 2000, originalHeight: 1000,
  });
  const regionAuth = registry.authorizeRegion(root.sourceId, [100, 100, 700, 900]);
  assert.equal(regionAuth.depth, 0);
  assert.deepEqual(regionAuth.rootBox, [100, 100, 700, 900]);
  assert.deepEqual(regionAuth.rootPixelBox, { left: 200, top: 100, width: 1200, height: 800 });
  const region = registry.registerRegion(root.sourceId, {
    buffer: Buffer.from('region'), mediaType: 'image/png', width: 600, height: 400,
  }, { rootBox: regionAuth.rootBox, regionKind: 'generic_zoom_tile' });
  assert.equal(region.depth, 0);

  const precise = registry.authorizeCrop(region.sourceId, [100, 100, 700, 700], 1);
  assert.equal(precise.depth, 1);
  assert.throws(() => registry.authorizeCrop(region.sourceId, [200, 200, 800, 800], 1), (error) => error?.code === 'visual_crop_count_limit');
});
