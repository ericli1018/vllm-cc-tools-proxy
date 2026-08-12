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
  assert.equal(result.width, 1200);
  assert.equal(result.height, 720);
});

test('V0.2.26 cropImage reads the root original image and root pixel box instead of the normalized overview', async () => {
  const fixture = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const rootBytes = Buffer.concat([fixture]);
  const overviewBytes = Buffer.concat([fixture]);
  let firstConvertInput = null;
  let convertCalls = 0;
  const runner = async (command, args) => {
    if (command === 'convert') {
      convertCalls += 1;
      if (convertCalls === 1) {
        firstConvertInput = await fs.readFile(args[0]);
        assert.match(args.join(' '), /300x90\+150\+45/);
      }
      await fs.writeFile(args.at(-1), fixture);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (command === 'identify') return { stdout: Buffer.from('600 180'), stderr: Buffer.alloc(0) };
    throw new Error(`unexpected ${command}`);
  };
  const asset = {
    buffer: overviewBytes, mediaType: 'image/png', width: 300, height: 90,
    rootBuffer: rootBytes, rootMediaType: 'image/png', rootWidth: 600, rootHeight: 180,
  };
  const result = await cropImage(asset, {
    pixelBox: { left: 75, top: 22, width: 150, height: 45 },
    rootPixelBox: { left: 150, top: 45, width: 300, height: 90 },
  }, { ...limits, runner });
  assert.deepEqual(firstConvertInput, rootBytes);
  assert.equal(result.mediaType, 'image/png');
});

test('V0.2.28.20 normalizeImage rejects normalized PNG expansion above byte profile', async (t) => {
  const fixture = await fs.readFile(new URL('./fixtures/text-image.png', import.meta.url));
  const maxDecodedBytes = fixture.length + 1024;
  const oversized = Buffer.alloc(maxDecodedBytes + 1, 0);
  oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const runner = async (command, args) => {
    if (command === 'identify') return { stdout: Buffer.from('600 180'), stderr: Buffer.alloc(0) };
    if (command === 'convert') {
      await fs.writeFile(args.at(-1), oversized);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected ${command}`);
  };
  await assert.rejects(
    normalizeImage(fixture, { ...limits, maxDecodedBytes, runner }),
    (error) => error?.code === 'media_too_large' && error?.status === 413,
  );
});
