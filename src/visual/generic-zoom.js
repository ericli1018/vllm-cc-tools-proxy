function axisSegments(count, overlap = 0.15) {
  if (count <= 1) return [[0, 1000]];
  const safeOverlap = Math.max(0, Math.min(0.4, Number(overlap) || 0));
  const size = 1000 / (count - ((count - 1) * safeOverlap));
  const stride = size * (1 - safeOverlap);
  const segments = [];
  for (let index = 0; index < count; index += 1) {
    let start = Math.round(index * stride);
    let end = Math.round(start + size);
    if (index === count - 1) end = 1000;
    if (end > 1000) {
      start = Math.max(0, start - (end - 1000));
      end = 1000;
    }
    segments.push([start, end]);
  }
  return segments;
}

export function buildGenericZoomTiles({ width, height, overlap = 0.15, maxTiles = 6 } = {}) {
  const ratio = Number(width) / Math.max(1, Number(height));
  let columns = 2;
  let rows = 2;
  if (ratio >= 2.1) { columns = 3; rows = 1; }
  else if (ratio <= 0.48) { columns = 1; rows = 3; }
  const xs = axisSegments(columns, overlap);
  const ys = axisSegments(rows, overlap);
  const tiles = [];
  let index = 1;
  for (const [top, bottom] of ys) {
    for (const [left, right] of xs) {
      if (tiles.length >= maxTiles) break;
      tiles.push({ index: index++, bbox: [left, top, right, bottom], overlap });
    }
  }
  return tiles;
}

export async function analyzeGenericZoomFallback(rootAsset, {
  registry,
  cropImage,
  analyzeTile,
  onProgress = async () => {},
  signal,
  overlap = 0.15,
  maxTiles = 6,
  isRecoverable = () => false,
} = {}) {
  const tiles = buildGenericZoomTiles({ width: rootAsset.width, height: rootAsset.height, overlap, maxTiles });
  const regions = [];
  const warnings = [];
  let cropCount = 0;
  await onProgress(`圖片需要局部放大，將切成 ${tiles.length} 個 overlapping tiles…`, {
    phase: 'image_zoom_tile', count: tiles.length, overlap,
  });

  for (const tile of tiles) {
    try {
      await onProgress(`正在建立放大區塊 ${tile.index}/${tiles.length}…`, {
        phase: 'image_zoom_tile_render', completed: tile.index, total: tiles.length, overlap,
      });
      const authorization = registry.authorizeCrop(rootAsset.sourceId, tile.bbox, 1);
      authorization.purpose = `automatic generic zoom tile ${tile.index}/${tiles.length}`;
      const crop = await cropImage(rootAsset, authorization, { signal });
      cropCount += 1;
      const asset = registry.registerCrop(rootAsset.sourceId, crop, authorization, { purpose: authorization.purpose });
      await onProgress(`正在分析放大區塊 ${tile.index}/${tiles.length}…`, {
        phase: 'image_zoom_tile_analyze', completed: tile.index, total: tiles.length, overlap,
      });
      const result = await analyzeTile(asset, tile);
      cropCount += Number(result?.cropCount || 0);
      warnings.push(...(result?.warnings || []));
      regions.push({ tile, sourceId: asset.sourceId, markdown: String(result?.markdown || ''), unresolved: Boolean(result?.needsZoom) });
    } catch (error) {
      if (!isRecoverable(error)) throw error;
      warnings.push(`image_zoom_tile_unavailable:${tile.index}`);
      regions.push({ tile, sourceId: '', markdown: `VISUAL_STATUS: UNREADABLE\nVISUAL_REASON: zoom tile ${tile.index} unavailable (${String(error?.code || 'vision_service_error')}).`, unresolved: true });
      await onProgress(`放大區塊 ${tile.index}/${tiles.length} 分析失敗，已略過並繼續…`, {
        phase: 'image_zoom_tile_failed', tile: tile.index, completed: tile.index, total: tiles.length, error_code: error?.code || 'vision_service_error',
      });
    }
  }

  const markdown = [
    '# Generic zoom evidence',
    `overlap: ${Math.round(overlap * 100)}%`,
    ...regions.flatMap(({ tile, sourceId, markdown: region, unresolved }) => [
      '',
      `## Tile ${tile.index}/${tiles.length} bbox=${JSON.stringify(tile.bbox)}${sourceId ? ` source_id=${sourceId}` : ''}${unresolved ? ' unresolved=true' : ''}`,
      region,
    ]),
  ].join('\n');

  return { markdown, warnings, cropCount, tileCount: tiles.length };
}
