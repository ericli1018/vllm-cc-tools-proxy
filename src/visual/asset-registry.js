import { HttpError } from '../lib/http.js';

function clampBox(box) {
  return box.map((value) => Math.max(0, Math.min(1000, Math.round(value))));
}


function expandBox(box, marginRatio = 0) {
  const safe = Math.max(0, Math.min(0.25, Number(marginRatio) || 0));
  if (safe <= 0) return [...box];
  const [left, top, right, bottom] = box;
  const xPad = (right - left) * safe;
  const yPad = (bottom - top) * safe;
  return clampBox([left - xPad, top - yPad, right + xPad, bottom + yPad]);
}

function composeRootBox(parentBox, bbox) {
  const [pl, pt, pr, pb] = parentBox;
  const [l, t, r, b] = bbox;
  const pw = pr - pl;
  const ph = pb - pt;
  return clampBox([
    pl + (l / 1000) * pw,
    pt + (t / 1000) * ph,
    pl + (r / 1000) * pw,
    pt + (b / 1000) * ph,
  ]);
}

function pixelBox(box, width, height) {
  const [leftN, topN, rightN, bottomN] = box;
  const left = Math.floor((leftN / 1000) * width);
  const top = Math.floor((topN / 1000) * height);
  const right = Math.ceil((rightN / 1000) * width);
  const bottom = Math.ceil((bottomN / 1000) * height);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export class VisualAssetRegistry {
  constructor({ maxCropRounds = 3, maxCropsPerAsset = 8, maxCropsPerRoot = maxCropsPerAsset, maxDepth = 2 } = {}) {
    this.maxCropRounds = maxCropRounds;
    this.maxCropsPerRoot = maxCropsPerRoot;
    this.maxDepth = maxDepth;
    this.assets = new Map();
    this.rootCropCounts = new Map();
    this.nextId = 1;
  }

  add({
    buffer, mediaType, width, height, label = '',
    originalBuffer = buffer, originalMediaType = mediaType,
    originalWidth = width, originalHeight = height,
    sourceKind = 'image', sourceMetadata = {},
  }) {
    if (!Buffer.isBuffer(buffer) || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new HttpError(422, 'Invalid visual asset.', { code: 'invalid_visual_asset' });
    }
    const sourceId = `asset-${this.nextId++}`;
    const asset = {
      sourceId,
      rootSourceId: sourceId,
      parentSourceId: null,
      depth: 0,
      rootBox: [0, 0, 1000, 1000],
      buffer,
      mediaType,
      width,
      height,
      label,
      sourceKind,
      sourceMetadata: { ...sourceMetadata },
      rootBuffer: Buffer.isBuffer(originalBuffer) ? originalBuffer : buffer,
      rootMediaType: originalMediaType || mediaType,
      rootWidth: Number.isFinite(originalWidth) && originalWidth > 0 ? originalWidth : width,
      rootHeight: Number.isFinite(originalHeight) && originalHeight > 0 ? originalHeight : height,
    };
    this.assets.set(sourceId, asset);
    this.rootCropCounts.set(sourceId, 0);
    return asset;
  }

  get(sourceId) {
    const asset = this.assets.get(sourceId);
    if (!asset) throw new HttpError(422, `Unknown visual source: ${sourceId}`, { code: 'unknown_visual_source' });
    return asset;
  }

  registerRegion(parentSourceId, image, { rootBox, label = '', regionKind = 'region', sourceMetadata = {} } = {}) {
    const parent = this.get(parentSourceId);
    if (!image || !Buffer.isBuffer(image.buffer) || !Number.isFinite(image.width) || !Number.isFinite(image.height)) {
      throw new HttpError(422, 'Invalid visual region asset.', { code: 'invalid_visual_asset' });
    }
    if (!Array.isArray(rootBox) || rootBox.length !== 4 || rootBox.some((value) => !Number.isFinite(value))) {
      throw new HttpError(422, 'Invalid visual region coordinates.', { code: 'invalid_visual_region_coordinates' });
    }
    const normalizedRootBox = clampBox(rootBox);
    if (normalizedRootBox[2] <= normalizedRootBox[0] || normalizedRootBox[3] <= normalizedRootBox[1]) {
      throw new HttpError(422, 'Invalid visual region rectangle.', { code: 'invalid_visual_region_rectangle' });
    }
    const root = this.get(parent.rootSourceId);
    const sourceId = `asset-${this.nextId++}`;
    const asset = {
      sourceId,
      rootSourceId: parent.rootSourceId,
      parentSourceId,
      depth: parent.depth,
      rootBox: normalizedRootBox,
      buffer: image.buffer,
      mediaType: image.mediaType || 'image/png',
      width: image.width,
      height: image.height,
      label: image.label || label || `${regionKind} of ${parentSourceId}`,
      regionKind,
      sourceKind: root.sourceKind,
      sourceMetadata: { ...root.sourceMetadata, ...sourceMetadata },
      rootBuffer: root.rootBuffer,
      rootMediaType: root.rootMediaType,
      rootWidth: root.rootWidth,
      rootHeight: root.rootHeight,
    };
    this.assets.set(sourceId, asset);
    return asset;
  }

  authorizeRegion(sourceId, bbox, { marginRatio = 0 } = {}) {
    const asset = this.get(sourceId);
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => !Number.isInteger(v) || v < 0 || v > 1000)) {
      throw new HttpError(422, 'Invalid region coordinates.', { code: 'invalid_visual_region_coordinates' });
    }
    const [leftN, topN, rightN, bottomN] = bbox;
    if (rightN <= leftN || bottomN <= topN) {
      throw new HttpError(422, 'Invalid visual region rectangle.', { code: 'invalid_visual_region_rectangle' });
    }
    const requestedBbox = [...bbox];
    const authorizedBbox = expandBox(bbox, marginRatio);
    const rootBox = composeRootBox(asset.rootBox, authorizedBbox);
    return {
      sourceId,
      rootSourceId: asset.rootSourceId,
      requestedBbox,
      bbox: authorizedBbox,
      purpose: '',
      depth: asset.depth,
      rootBox,
      pixelBox: pixelBox(authorizedBbox, asset.width, asset.height),
      rootPixelBox: pixelBox(rootBox, asset.rootWidth, asset.rootHeight),
    };
  }

  authorizeCrop(sourceId, bbox, round, { marginRatio = 0 } = {}) {
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
    const depth = asset.depth + 1;
    if (depth > this.maxDepth) {
      throw new HttpError(422, 'Visual crop depth limit exceeded.', { code: 'visual_crop_depth_limit' });
    }
    const rootCount = this.rootCropCounts.get(asset.rootSourceId) || 0;
    if (rootCount >= this.maxCropsPerRoot) {
      throw new HttpError(422, 'Visual crop count limit exceeded.', { code: 'visual_crop_count_limit' });
    }
    this.rootCropCounts.set(asset.rootSourceId, rootCount + 1);
    const requestedBbox = [...bbox];
    const authorizedBbox = expandBox(bbox, marginRatio);
    const rootBox = composeRootBox(asset.rootBox, authorizedBbox);
    return {
      sourceId,
      rootSourceId: asset.rootSourceId,
      requestedBbox,
      bbox: authorizedBbox,
      purpose: '',
      depth,
      rootBox,
      pixelBox: pixelBox(authorizedBbox, asset.width, asset.height),
      rootPixelBox: pixelBox(rootBox, asset.rootWidth, asset.rootHeight),
    };
  }

  registerCrop(parentSourceId, crop, authorization, { purpose = '' } = {}) {
    const parent = this.get(parentSourceId);
    if (!crop || !Buffer.isBuffer(crop.buffer) || !Number.isFinite(crop.width) || !Number.isFinite(crop.height)) {
      throw new HttpError(422, 'Invalid visual crop asset.', { code: 'invalid_visual_asset' });
    }
    if (authorization?.rootSourceId !== parent.rootSourceId || authorization?.sourceId !== parentSourceId) {
      throw new HttpError(422, 'Visual crop authorization does not match its parent.', { code: 'invalid_visual_crop_authorization' });
    }
    const sourceId = `asset-${this.nextId++}`;
    const root = this.get(parent.rootSourceId);
    const asset = {
      sourceId,
      rootSourceId: parent.rootSourceId,
      parentSourceId,
      depth: authorization.depth,
      rootBox: [...authorization.rootBox],
      buffer: crop.buffer,
      mediaType: crop.mediaType || 'image/png',
      width: crop.width,
      height: crop.height,
      label: crop.label || `crop of ${parentSourceId}: ${String(purpose || authorization.purpose || '').slice(0, 200)}`,
      sourceKind: root.sourceKind,
      sourceMetadata: { ...root.sourceMetadata },
      rootBuffer: root.rootBuffer,
      rootMediaType: root.rootMediaType,
      rootWidth: root.rootWidth,
      rootHeight: root.rootHeight,
    };
    this.assets.set(sourceId, asset);
    return asset;
  }
}
