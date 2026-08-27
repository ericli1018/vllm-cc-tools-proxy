import { boundedText } from '../lib/media.js';

const UNCERTAINTY_RE = /\b(uncertain|uncertainty|ambiguous|conflict|illegible|unreadable|not clear|cannot confirm|unknown)\b/i;

function cleanLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(assistant|user|tool|tool_result)\s*:/i.test(line));
}

function boxesOverlap(a, b) {
  if (!Array.isArray(a) || a.length !== 4 || !Array.isArray(b) || b.length !== 4) return false;
  const left = Math.max(Number(a[0]), Number(b[0]));
  const top = Math.max(Number(a[1]), Number(b[1]));
  const right = Math.min(Number(a[2]), Number(b[2]));
  const bottom = Math.min(Number(a[3]), Number(b[3]));
  return Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom)
    && right > left && bottom > top;
}

function clipped(value, maxChars) {
  return boundedText(String(value || '').trim(), maxChars).text.trim();
}

function priorRegionSummary(region, maxChars = 700) {
  const lines = cleanLines(region?.markdown);
  const observations = [];
  const uncertainty = [];
  for (const line of lines) {
    if (UNCERTAINTY_RE.test(line)) uncertainty.push(line);
    else observations.push(line);
  }
  const parts = [];
  if (observations.length) parts.push(...observations.slice(0, 6));
  if (uncertainty.length) parts.push(...uncertainty.slice(0, 3));
  return clipped(parts.join('\n'), maxChars);
}

export function buildPdfZoomContext({
  page,
  route,
  overview = '',
  nativeText = '',
  currentTile,
  priorRegions = [],
  maxChars = 4200,
  maxPriorRegions = 2,
} = {}) {
  const safeMaxChars = Math.max(800, Number(maxChars) || 4200);
  const overviewText = clipped(overview, Math.min(1600, Math.floor(safeMaxChars * 0.42)));
  const native = clipped(nativeText, Math.min(900, Math.floor(safeMaxChars * 0.24)));
  const currentBox = currentTile?.bbox;
  const adjacent = (priorRegions || [])
    .filter((region) => boxesOverlap(currentBox, region?.bbox))
    .slice(-Math.max(1, Number(maxPriorRegions) || 2));

  const lines = [
    `[VCC_PDF_ZOOM_CONTEXT page=${page ?? 'unknown'} route=${route || 'DENSE_PAGE'} tile=${currentTile?.index ?? 'unknown'}]`,
    `Page ${page ?? 'unknown'} context for ${route || 'DENSE_PAGE'} tile ${currentTile?.index ?? 'unknown'}.`,
    'This is bounded carry-forward context, not a transcript. Re-verify every carried observation against the current tile before asserting continuity.',
  ];
  if (overviewText) lines.push('', 'Whole-page overview:', overviewText);
  if (native) lines.push('', 'Relevant native PDF text:', native);
  if (adjacent.length) {
    lines.push('', 'Prior adjacent tile observations:');
    for (const region of adjacent) {
      const summary = priorRegionSummary(region);
      if (!summary) continue;
      lines.push(`- tile=${region?.tileIndex ?? 'unknown'} source_id=${region?.sourceId || 'unknown'}`, summary);
    }
  }
  lines.push('', '[VCC_PDF_ZOOM_CONTEXT_END]');
  return boundedText(lines.join('\n').trim(), safeMaxChars).text.trim();
}
