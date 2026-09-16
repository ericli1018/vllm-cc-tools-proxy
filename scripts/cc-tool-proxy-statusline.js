#!/usr/bin/env node

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function statusUrl(baseValue, sessionId) {
  const base = new URL(String(baseValue || '').trim());
  base.pathname = `/cc-tool-proxy/status/${encodeURIComponent(sessionId)}`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

function charWidth(ch) {
  const cp = String(ch || '').codePointAt(0);
  if (!Number.isInteger(cp)) return 0;
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if (/\p{Mark}/u.test(ch)) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  const wide = cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
  return wide ? 2 : 1;
}

function displayWidth(text) {
  return [...String(text || '')].reduce((sum, ch) => sum + charWidth(ch), 0);
}

function sanitizePreviewLine(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function takePrefixColumns(text, maxColumns) {
  let width = 0;
  let output = '';
  for (const ch of [...String(text || '')]) {
    const next = width + charWidth(ch);
    if (next > maxColumns) break;
    output += ch;
    width = next;
  }
  return output;
}

function takeSuffixColumns(text, maxColumns) {
  const chars = [...String(text || '')];
  let width = 0;
  const output = [];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const ch = chars[index];
    const next = width + charWidth(ch);
    if (next > maxColumns) break;
    output.push(ch);
    width = next;
  }
  return output.reverse().join('');
}

function dropLeftColumns(text, columns) {
  const chars = [...String(text || '')];
  let removed = 0;
  let index = 0;
  while (index < chars.length && removed < columns) {
    removed += charWidth(chars[index]);
    index += 1;
  }
  return chars.slice(index).join('');
}

function terminalColumns() {
  const value = Number.parseInt(String(process.env.COLUMNS || ''), 10);
  return Number.isInteger(value) && value >= 20 ? Math.min(400, value) : 120;
}

function renderPreview(preview, columns = terminalColumns()) {
  if (!preview || !['thinking', 'response'].includes(String(preview.phase || ''))) return '';
  const prefix = '↳ ';
  const cursor = '▌';
  const previous = sanitizePreviewLine(preview.previous_line);
  const current = sanitizePreviewLine(preview.current_line);
  if (!previous && !current) return '';

  const bodyColumns = Math.max(1, columns - displayWidth(prefix));
  const cursorColumns = displayWidth(cursor);
  const currentWidth = displayWidth(current);

  if (!current) {
    const available = Math.max(1, bodyColumns - cursorColumns);
    if (displayWidth(previous) <= available) return `${prefix}${previous}${cursor}`;
    const tail = takeSuffixColumns(previous, Math.max(1, available - 1));
    return `${prefix}…${tail}${cursor}`;
  }

  if (currentWidth + cursorColumns > bodyColumns) {
    const tail = takeSuffixColumns(current, Math.max(1, bodyColumns - cursorColumns - 1));
    return `${prefix}…${tail}${cursor}`;
  }

  const previousTail = dropLeftColumns(previous, currentWidth);
  const composite = `${current}${cursor}${previousTail}`;
  return `${prefix}${takePrefixColumns(composite, bodyColumns)}`;
}

async function main() {
  const input = await readStdin();
  const sessionId = typeof input?.session_id === 'string' ? input.session_id.trim() : '';
  const baseUrl = String(process.env.CC_TOOL_PROXY_URL || process.env.ANTHROPIC_BASE_URL || '').trim();
  if (!sessionId || !baseUrl) return;
  try {
    const response = await fetch(statusUrl(baseUrl, sessionId), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return;
    const payload = await response.json();
    if (typeof payload?.display === 'string' && payload.display.trim()) {
      const lines = [payload.display.trim()];
      const previewLine = renderPreview(payload.preview);
      if (previewLine) lines.push(previewLine);
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } catch {
    // statusLine must stay quiet on transient Proxy/network errors.
  }
}

main().catch(() => {});
