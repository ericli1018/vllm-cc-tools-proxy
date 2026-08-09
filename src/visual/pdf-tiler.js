function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedCuts(count, overlap) {
  if (count <= 1) return [[0, 1000]];
  const nominal = 1000 / count;
  const pad = (nominal * overlap) / 2;
  const cuts = [];
  for (let index = 0; index < count; index += 1) {
    const left = index === 0 ? 0 : Math.floor(index * nominal - pad);
    const right = index === count - 1 ? 1000 : Math.ceil((index + 1) * nominal + pad);
    cuts.push([clamp(left, 0, 1000), clamp(right, 0, 1000)]);
  }
  return cuts;
}

function boundedGrid(widthPx, heightPx, targetLongEdgePx, maxTiles) {
  let target = Math.max(512, targetLongEdgePx);
  let cols = Math.max(1, Math.ceil(widthPx / target));
  let rows = Math.max(1, Math.ceil(heightPx / target));
  while (cols * rows > maxTiles) {
    target *= 1.12;
    cols = Math.max(1, Math.ceil(widthPx / target));
    rows = Math.max(1, Math.ceil(heightPx / target));
  }
  return { cols, rows };
}

export function buildPdfTiles(pageSize, {
  overlap = 0.15,
  targetLongEdgePx = 2300,
  dpi = 360,
  maxTiles = 12,
} = {}) {
  const widthPoints = Number(pageSize?.width);
  const heightPoints = Number(pageSize?.height);
  if (!Number.isFinite(widthPoints) || widthPoints <= 0 || !Number.isFinite(heightPoints) || heightPoints <= 0) {
    throw new TypeError('Valid PDF page dimensions are required.');
  }
  const safeOverlap = clamp(Number(overlap) || 0, 0, 0.45);
  const safeMaxTiles = Math.max(1, Math.floor(Number(maxTiles) || 12));
  const widthPx = (widthPoints * dpi) / 72;
  const heightPx = (heightPoints * dpi) / 72;
  const { cols, rows } = boundedGrid(widthPx, heightPx, targetLongEdgePx, safeMaxTiles);
  const xs = normalizedCuts(cols, safeOverlap);
  const ys = normalizedCuts(rows, safeOverlap);
  const tiles = [];
  let index = 1;
  for (let row = 0; row < ys.length; row += 1) {
    for (let col = 0; col < xs.length; col += 1) {
      tiles.push({ index: index++, row: row + 1, column: col + 1, bbox: [xs[col][0], ys[row][0], xs[col][1], ys[row][1]] });
    }
  }
  return tiles;
}
