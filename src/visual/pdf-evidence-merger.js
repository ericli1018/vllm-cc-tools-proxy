function cleanLines(markdown) {
  return String(markdown || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function dedupeRegionLines(regions) {
  const seen = new Set();
  const output = [];
  const uncertainty = [];
  for (const region of regions || []) {
    const sourceId = String(region?.sourceId || 'unknown');
    const accepted = [];
    for (const line of cleanLines(region?.markdown)) {
      const key = line.replace(/^[-*]\s+/, '').trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        accepted.push(line);
      }
      if (/\b(uncertain|uncertainty|ambiguous|conflict|illegible|unreadable|not clear|cannot confirm)\b/i.test(line)) {
        uncertainty.push(`${sourceId}: ${line}`);
      }
    }
    output.push({ sourceId, lines: accepted });
  }
  return { output, uncertainty: [...new Set(uncertainty)] };
}

export function mergePageEvidence({ page, route, nativeText = '', overview = '', regions = [] } = {}) {
  const { output, uncertainty } = dedupeRegionLines(regions);
  const lines = [`## Page ${page} — ${route || 'DENSE_PAGE'}`];
  if (String(nativeText || '').trim()) lines.push('', '### Native text', String(nativeText).trim());
  if (String(overview || '').trim()) lines.push('', '### Overview', String(overview).trim());
  if (output.length > 0) {
    lines.push('', '### Region evidence');
    for (const region of output) {
      lines.push(`- source_id=${region.sourceId}`);
      for (const line of region.lines) lines.push(`  ${line}`);
    }
  }
  if (uncertainty.length > 0) {
    lines.push('', '### Uncertainty / conflicts');
    for (const item of uncertainty) lines.push(`- ${item}`);
  }
  return lines.join('\n').trim();
}
