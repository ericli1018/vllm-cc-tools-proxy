import test from 'node:test';
import assert from 'node:assert/strict';
import { batchVisualPages } from '../src/visual/pdf-batcher.js';

test('batchVisualPages creates stable bounded batches', () => {
  const pages = Array.from({ length: 9 }, (_, i) => ({ page: i + 1 }));
  assert.deepEqual(batchVisualPages(pages, 4).map((batch) => batch.map((p) => p.page)), [[1,2,3,4],[5,6,7,8],[9]]);
});
