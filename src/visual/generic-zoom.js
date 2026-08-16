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

const VISUAL_BUDGET_CODES = new Set([
  'visual_crop_count_limit',
  'visual_crop_depth_limit',
  'visual_crop_round_limit',
  'visual_crop_batch_limit',
]);

function isVisualBudgetExhausted(error) {
  return VISUAL_BUDGET_CODES.has(error?.code);
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
      const authorization = registry.authorizeRegion(rootAsset.sourceId, tile.bbox);
      authorization.purpose = `automatic generic zoom tile ${tile.index}/${tiles.length}`;
      const crop = await cropImage(rootAsset, authorization, { signal });
      const asset = registry.registerRegion(rootAsset.sourceId, crop, {
        rootBox: authorization.rootBox,
        label: authorization.purpose,
        regionKind: 'generic_zoom_tile',
        sourceMetadata: { tileIndex: tile.index, tileCount: tiles.length, overlap },
      });
      await onProgress(`正在分析放大區塊 ${tile.index}/${tiles.length}…`, {
        phase: 'image_zoom_tile_analyze', completed: tile.index, total: tiles.length, overlap,
      });
      const result = await analyzeTile(asset, tile);
      cropCount += Number(result?.cropCount || 0);
      warnings.push(...(result?.warnings || []));
      const status = result?.needsZoom ? 'unresolved' : (result?.cacheable === false || result?.visualCompleteness === 'partial' ? 'partial' : 'resolved');
      regions.push({ tile, sourceId: asset.sourceId, markdown: String(result?.markdown || ''), status });
    } catch (error) {
      const budgetExhausted = isVisualBudgetExhausted(error);
      if (!budgetExhausted && !isRecoverable(error)) throw error;
      const code = String(error?.code || 'vision_service_error');
      warnings.push(`image_zoom_tile_unavailable:${tile.index}`);
      if (budgetExhausted) warnings.push(`vision_zoom_budget_exhausted:${code}`);
      regions.push({ tile, sourceId: '', markdown: `VISUAL_STATUS: UNREADABLE\nVISUAL_REASON: zoom tile ${tile.index} unavailable (${code}).`, status: 'failed' });
      await onProgress(
        budgetExhausted
          ? `圖片局部裁切額度已達安全上限；放大區塊 ${tile.index}/${tiles.length} 將使用現有證據並繼續…`
          : `放大區塊 ${tile.index}/${tiles.length} 分析失敗，已略過並繼續…`,
        {
          phase: budgetExhausted ? 'image_zoom_budget_exhausted' : 'image_zoom_tile_failed',
          tile: tile.index, completed: tile.index, total: tiles.length, error_code: code,
        },
      );
    }
  }

  const resolvedCount = regions.filter((region) => region.status === 'resolved').length;
  const unresolvedCount = regions.filter((region) => region.status === 'unresolved').length;
  const partialCount = regions.filter((region) => region.status === 'partial').length;
  const failedCount = regions.filter((region) => region.status === 'failed').length;
  const budgetExhaustedCount = warnings.filter((warning) => warning.startsWith('vision_zoom_budget_exhausted:')).length;
  const cacheable = unresolvedCount === 0 && partialCount === 0 && failedCount === 0;
  const terminalStatus = cacheable ? 'resolved' : ((resolvedCount + partialCount) > 0 ? 'partial' : 'unreadable');
  if (unresolvedCount > 0) warnings.push(`vision_generic_zoom_unresolved:${unresolvedCount}`);
  if (partialCount > 0) warnings.push(`vision_generic_zoom_partial:${partialCount}`);
  if (failedCount > 0) warnings.push(`vision_generic_zoom_failed:${failedCount}`);

  const markdown = [
    '# Generic zoom evidence',
    `overlap: ${Math.round(overlap * 100)}%`,
    `terminal_status: ${terminalStatus}`,
    `resolved: ${resolvedCount}/${tiles.length}; partial: ${partialCount}; unresolved: ${unresolvedCount}; failed: ${failedCount}`,
    ...regions.flatMap(({ tile, sourceId, markdown: region, status }) => [
      '',
      `## Tile ${tile.index}/${tiles.length} bbox=${JSON.stringify(tile.bbox)}${sourceId ? ` source_id=${sourceId}` : ''}${status === 'partial' ? ' partial=true' : ''}${status === 'unresolved' ? ' unresolved=true' : ''}${status === 'failed' ? ' failed=true' : ''}`,
      region,
    ]),
  ].join('\n');

  return {
    markdown,
    warnings,
    cropCount,
    tileCount: tiles.length,
    resolvedCount,
    unresolvedCount,
    partialCount,
    failedCount,
    budgetExhaustedCount,
    cacheable,
    terminalStatus,
  };
}
