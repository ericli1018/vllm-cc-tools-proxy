import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function runClient({ input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/cc-tool-proxy-statusline.js'], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('V0.2.28.16 Claude statusLine client queries the Proxy with stdin session_id and prints server-localized display', async (t) => {
  let observedPath = '';
  const server = http.createServer((req, res) => {
    observedPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ display: '◆ CC TOOL PROXY 0.2.28.16 │ ◓ 思考中 │ 59s │ 44.83 KB │ 760 B/s' }));
  });
  const url = await listen(server);
  t.after(() => server.close());

  const result = await runClient({
    input: { session_id: 'session/a b' },
    env: { CC_TOOL_PROXY_URL: `${url}/v1` },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), '◆ CC TOOL PROXY 0.2.28.16 │ ◓ 思考中 │ 59s │ 44.83 KB │ 760 B/s');
  assert.equal(observedPath, '/cc-tool-proxy/status/session%2Fa%20b');
});


function terminalWidth(text) {
  let width = 0;
  for (const ch of [...String(text)]) {
    const cp = ch.codePointAt(0);
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

test('V0.29.35 statusLine renders a two-line CJK wipe preview with a plain ▌ cursor and no terminal control sequences', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      display: '◆ CC TOOL PROXY 0.29.35 │ ◓ 思考中 │ 45s │ 11.26 KB │ 278 B/s',
      preview: {
        phase: 'thinking',
        previous_line: '這把管理方向性講清楚了。我重新整理管理方向的圖，注意這與前面',
        current_line: '我重新整',
      },
    }));
  });
  const url = await listen(server);
  t.after(() => server.close());
  const result = await runClient({
    input: { session_id: 'wipe-session' },
    env: { CC_TOOL_PROXY_URL: `${url}/v1`, COLUMNS: '72' },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /\r|\x1b/);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^↳ 我重新整▌方向性講清楚了/);
  assert.ok(terminalWidth(lines[1]) <= 72, `preview width=${terminalWidth(lines[1])}`);
});

test('V0.29.35 statusLine tail-follows a long current logical line instead of wrapping into a third row', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      display: '◆ CC TOOL PROXY 0.29.35 │ ◆ 回應中 │ 51s',
      preview: { phase: 'response', previous_line: '舊行不應再露出', current_line: `開頭${'長'.repeat(100)}結尾` },
    }));
  });
  const url = await listen(server);
  t.after(() => server.close());
  const result = await runClient({ input: { session_id: 'tail-session' }, env: { CC_TOOL_PROXY_URL: `${url}/v1`, COLUMNS: '44' } });
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^↳ …/);
  assert.match(lines[1], /結尾▌$/);
  assert.doesNotMatch(lines[1], /舊行不應再露出/);
  assert.ok(terminalWidth(lines[1]) <= 44, `preview width=${terminalWidth(lines[1])}`);
});

for (const kind of ['explicit', 'bearer', 'api-key', 'different-origin']) {
  test(`V0.29.75 statusLine credential selection: ${kind}`, async t => {
    let authorization, apiKey;
    const server = http.createServer((req,res) => {
      authorization = req.headers.authorization; apiKey = req.headers['x-api-key'];
      res.setHeader('content-type','application/json'); res.end(JSON.stringify({ display: 'status available' }));
    });
    const url = await listen(server); t.after(() => server.close());
    const env = { CC_TOOL_PROXY_URL: url, CC_TOOL_PROXY_API_KEY: '', ANTHROPIC_BASE_URL: url+'/v1', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' };
    if (kind === 'explicit') { env.CC_TOOL_PROXY_API_KEY = 'status-key'; env.ANTHROPIC_AUTH_TOKEN = 'not-this-key'; }
    if (kind === 'bearer') env.ANTHROPIC_AUTH_TOKEN = 'status-key';
    if (kind === 'api-key') env.ANTHROPIC_API_KEY = 'status-key';
    if (kind === 'different-origin') { env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'; env.ANTHROPIC_AUTH_TOKEN = 'do-not-leak'; }
    const result = await runClient({ input: { session_id: 'auth-session' }, env });
    assert.equal(result.code, 0); assert.equal(result.stdout.trim(), 'status available'); assert.equal(result.stderr,'');
    assert.equal(authorization, kind === 'different-origin' ? undefined : 'Bearer status-key');
    assert.equal(apiKey, undefined);
  });
}

test('V0.29.75 statusLine refuses redirects and never sends credentials to redirect target', async t => {
  let targetCalls = 0;
  const target = http.createServer((req,res) => { targetCalls++; res.end('{}'); });
  const targetUrl = await listen(target); t.after(() => target.close());
  const server = http.createServer((req,res) => { res.writeHead(302, { location: targetUrl+'/capture' }); res.end(); });
  const url = await listen(server); t.after(() => server.close());
  const result = await runClient({ input: { session_id: 'private' }, env: { CC_TOOL_PROXY_URL: url, CC_TOOL_PROXY_API_KEY: 'status-key' } });
  assert.equal(targetCalls,0); assert.equal(result.stdout,''); assert.equal(result.stderr,'');
});
