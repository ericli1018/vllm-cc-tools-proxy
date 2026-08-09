import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdfTiles } from '../src/visual/pdf-tiler.js';

function coversPoint(tiles, x, y) {
  return tiles.some(({ bbox }) => bbox[0] <= x && bbox[2] >= x && bbox[1] <= y && bbox[3] >= y);
}

test('V0.2.27 schematic tiler covers the whole page with deterministic overlap', () => {
  const pageSize = { width: 595, height: 842 };
  const first = buildPdfTiles(pageSize);
  const second = buildPdfTiles(pageSize);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2 && first.length <= 12);
  for (const tile of first) {
    assert.equal(tile.index >= 1, true);
    assert.equal(tile.bbox.length, 4);
    assert.equal(tile.bbox.every((value) => Number.isInteger(value) && value >= 0 && value <= 1000), true);
    assert.ok(tile.bbox[2] > tile.bbox[0]);
    assert.ok(tile.bbox[3] > tile.bbox[1]);
  }
  for (const [x, y] of [[0,0], [500,0], [1000,0], [0,500], [500,500], [1000,500], [0,1000], [500,1000], [1000,1000]]) {
    assert.equal(coversPoint(first, x, y), true, `point ${x},${y} must be covered`);
  }
  const horizontalOverlap = first.some((a, i) => first.some((b, j) => i !== j
    && a.bbox[1] === b.bbox[1]
    && a.bbox[0] < b.bbox[0]
    && a.bbox[2] > b.bbox[0]));
  const verticalOverlap = first.some((a, i) => first.some((b, j) => i !== j
    && a.bbox[0] === b.bbox[0]
    && a.bbox[1] < b.bbox[1]
    && a.bbox[3] > b.bbox[1]));
  assert.equal(horizontalOverlap || verticalOverlap, true);
});

test('V0.2.27 schematic tiler bounds huge pages to maxTiles', () => {
  const tiles = buildPdfTiles({ width: 2384, height: 3370 }, { maxTiles: 12 });
  assert.ok(tiles.length <= 12);
  assert.equal(coversPoint(tiles, 1000, 1000), true);
});
