import { HttpError } from '../lib/http.js';

export class VisualAssetRegistry {
  constructor({ maxCropRounds = 2, maxCropsPerAsset = 6 } = {}) {
    this.maxCropRounds = maxCropRounds;
    this.maxCropsPerAsset = maxCropsPerAsset;
    this.assets = new Map();
    this.nextId = 1;
  }

  add({ buffer, mediaType, width, height, label = '' }) {
    if (!Buffer.isBuffer(buffer) || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new HttpError(422, 'Invalid visual asset.', { code: 'invalid_visual_asset' });
    }
    const sourceId = `asset-${this.nextId++}`;
    const asset = { sourceId, buffer, mediaType, width, height, label, cropCount: 0 };
    this.assets.set(sourceId, asset);
    return asset;
  }

  get(sourceId) {
    const asset = this.assets.get(sourceId);
    if (!asset) throw new HttpError(422, `Unknown visual source: ${sourceId}`, { code: 'unknown_visual_source' });
    return asset;
  }

  authorizeCrop(sourceId, bbox, round) {
    const asset = this.get(sourceId);
    if (!Number.isInteger(round) || round < 1 || round > this.maxCropRounds) {
      throw new HttpError(422, 'Visual crop round limit exceeded.', { code: 'visual_crop_round_limit' });
    }
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => !Number.isInteger(v) || v < 0 || v > 1000)) {
      throw new HttpError(422, 'Invalid crop coordinates.', { code: 'invalid_visual_crop_coordinates' });
    }
    const [leftN, topN, rightN, bottomN] = bbox;
    if (rightN <= leftN || bottomN <= topN) {
      throw new HttpError(422, 'Invalid crop rectangle.', { code: 'invalid_visual_crop_rectangle' });
    }
    const areaRatio = ((rightN - leftN) * (bottomN - topN)) / 1_000_000;
    if (areaRatio < 0.01) {
      throw new HttpError(422, 'Invalid crop: region is too small.', { code: 'crop_region_too_small' });
    }
    if (asset.cropCount >= this.maxCropsPerAsset) {
      throw new HttpError(422, 'Visual crop count limit exceeded.', { code: 'visual_crop_count_limit' });
    }
    asset.cropCount += 1;
    const left = Math.floor((leftN / 1000) * asset.width);
    const top = Math.floor((topN / 1000) * asset.height);
    const right = Math.ceil((rightN / 1000) * asset.width);
    const bottom = Math.ceil((bottomN / 1000) * asset.height);
    return { sourceId, bbox, purpose: '', pixelBox: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) } };
  }
}
