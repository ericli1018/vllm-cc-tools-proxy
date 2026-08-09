function pendingMediaText(block) {
  if (block?.type === 'document') return '[VCC pending PDF evidence]';
  if (block?.type === 'image') return '[VCC pending image evidence]';
  return '';
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  if (['document', 'image'].includes(value.type) && value.source && typeof value.source === 'object') {
    return { type: 'text', text: pendingMediaText(value) };
  }
  const clone = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = sanitizeValue(entry);
  return clone;
}

export function buildMediaUsageBootstrapRequest(request) {
  const clone = sanitizeValue(request);
  clone.stream = false;
  return clone;
}
