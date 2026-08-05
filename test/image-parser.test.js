import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { normalizeImage, cropImage } from '../src/parsers/image.js';

const limits = { maxDecodedBytes: 5_000_000, maxImagePixels: 5_000_000, processTimeoutMs: 10000 };

test('normalizeImage returns safe PNG metadata and bytes', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const result = await normalizeImage(buffer, limits);
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.width, 600);
  assert.equal(result.height, 180);
  assert.equal(result.buffer.subarray(1,4).toString('ascii'), 'PNG');
});

test('cropImage crops authorized pixel bounds and returns normalized PNG', async () => {
  const buffer = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const normalized = await normalizeImage(buffer, limits);
  const result = await cropImage(normalized, { pixelBox: { left: 0, top: 0, width: 300, height: 180 } }, limits);
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.width, 600);
  assert.equal(result.height, 360);
});
