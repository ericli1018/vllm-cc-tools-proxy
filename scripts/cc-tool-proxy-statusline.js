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
      process.stdout.write(`${payload.display.trim()}\n`);
    }
  } catch {
    // statusLine must stay quiet on transient Proxy/network errors.
  }
}

main().catch(() => {});
