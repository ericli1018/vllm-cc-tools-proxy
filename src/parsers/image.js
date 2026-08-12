import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectMediaType } from '../lib/media.js';
import { HttpError } from '../lib/http.js';
import { runCommand } from '../lib/process.js';

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

function parseGeometry(value) {
  const [width, height] = String(value).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new HttpError(422, 'Image dimensions could not be determined.', { code: 'invalid_image' });
  }
  return { width, height };
}

async function identify(file, options) {
  const result = await options.runner('identify', ['-format', '%w %h', file], {
    timeoutMs: options.processTimeoutMs, signal: options.signal, maxOutputBytes: 1024,
  });
  return parseGeometry(result.stdout.toString('utf8'));
}

export async function normalizeImage(buffer, {
  maxDecodedBytes, maxImagePixels, processTimeoutMs, signal, runner = runCommand,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(422, 'Image body is empty.', { code: 'invalid_image' });
  if (buffer.length > maxDecodedBytes) throw new HttpError(413, 'Image exceeds the configured byte limit.', { code: 'media_too_large' });
  const mediaType = detectMediaType(buffer);
  const extension = EXTENSIONS[mediaType];
  if (!extension) throw new HttpError(422, 'Unsupported or invalid image format.', { code: 'unsupported_image' });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-cc-image-'));
  const inputPath = path.join(directory, `input${extension}`);
  const outputPath = path.join(directory, 'normalized.png');
  const options = { maxDecodedBytes, maxImagePixels, processTimeoutMs, signal, runner };
  try {
    await fs.writeFile(inputPath, buffer, { mode: 0o600 });
    const inputRef = mediaType === 'image/gif' || mediaType === 'image/webp' ? `${inputPath}[0]` : inputPath;
    const original = await identify(inputRef, options);
    if (original.width * original.height > maxImagePixels) throw new HttpError(413, 'Image exceeds the configured pixel limit.', { code: 'image_too_large' });
    await runner('convert', [inputRef, '-auto-orient', '-resize', '4096x4096>', '-strip', outputPath], {
      timeoutMs: processTimeoutMs, signal, maxOutputBytes: 1024 * 1024,
    });
    const normalized = await identify(outputPath, options);
    const output = await fs.readFile(outputPath);
    if (output.length > maxDecodedBytes) {
      throw new HttpError(413, 'Normalized image exceeds the configured byte limit.', { code: 'media_too_large' });
    }
    return { buffer: output, mediaType: 'image/png', width: normalized.width, height: normalized.height, originalWidth: original.width, originalHeight: original.height, warnings: [] };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function cropImage(asset, authorization, {
  maxDecodedBytes = 32 * 1024 * 1024, maxImagePixels = 40_000_000, processTimeoutMs = 120_000, signal, runner = runCommand,
} = {}) {
  const { left, top, width, height } = authorization?.pixelBox || {};
  if (![left, top, width, height].every(Number.isFinite) || width < 1 || height < 1) {
    throw new HttpError(422, 'Invalid authorized crop.', { code: 'invalid_visual_crop' });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-cc-crop-'));
  const inputPath = path.join(directory, 'input.png');
  const outputPath = path.join(directory, 'crop.png');
  try {
    const rootBuffer = Buffer.isBuffer(asset.rootBuffer) ? asset.rootBuffer : asset.buffer;
    const rootBox = authorization?.rootPixelBox || authorization?.pixelBox;
    const cropLeft = rootBox?.left;
    const cropTop = rootBox?.top;
    const cropWidth = rootBox?.width;
    const cropHeight = rootBox?.height;
    if (![cropLeft, cropTop, cropWidth, cropHeight].every(Number.isFinite) || cropWidth < 1 || cropHeight < 1) {
      throw new HttpError(422, 'Invalid authorized root crop.', { code: 'invalid_visual_crop' });
    }
    await fs.writeFile(inputPath, rootBuffer, { mode: 0o600 });
    const longEdge = Math.max(cropWidth, cropHeight);
    const scale = Math.max(0.5, Math.min(4, 2400 / longEdge));
    const targetWidth = Math.max(1, Math.round(cropWidth * scale));
    const targetHeight = Math.max(1, Math.round(cropHeight * scale));
    await runner('convert', [inputPath, '-crop', `${cropWidth}x${cropHeight}+${cropLeft}+${cropTop}`, '+repage', '-resize', `${targetWidth}x${targetHeight}`, '-strip', outputPath], {
      timeoutMs: processTimeoutMs, signal, maxOutputBytes: 1024 * 1024,
    });
    const result = await normalizeImage(await fs.readFile(outputPath), { maxDecodedBytes, maxImagePixels, processTimeoutMs, signal, runner });
    return result;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
