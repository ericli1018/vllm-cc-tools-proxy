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
