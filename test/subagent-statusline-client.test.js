import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function runClient(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/cc-tool-proxy-subagent-statusline.js'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function jsonLines(stdout) {
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test('V0.29.19 subagentStatusLine renders the Claude Code task description for each visible row', async () => {
  const result = await runClient({
    columns: 100,
    tasks: [
      { id: 'task-a', name: 'Explore', type: 'local_agent', status: 'in_progress', description: '分析 WebSearch 行為', label: 'Explore' },
      { id: 'task-b', name: 'general-purpose', type: 'local_agent', status: 'completed', description: '檢查記憶體問題', label: 'Worker' },
    ],
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(jsonLines(result.stdout), [
    { id: 'task-a', content: '分析 WebSearch 行為' },
    { id: 'task-b', content: '檢查記憶體問題' },
  ]);
});

test('V0.29.19 subagentStatusLine sanitizes row text and falls back without inventing progress content', async () => {
  const result = await runClient({
    tasks: [
      { id: 'task-a', description: '  第一行\n第二行\u0000  ' },
      { id: 'task-b', description: '', label: 'Fallback label' },
      { id: 'task-c', description: '', label: '', name: 'Explore' },
      { id: '', description: 'must be ignored' },
    ],
  });
  assert.equal(result.code, 0);
  assert.deepEqual(jsonLines(result.stdout), [
    { id: 'task-a', content: '第一行 第二行' },
    { id: 'task-b', content: 'Fallback label' },
    { id: 'task-c', content: 'Explore' },
  ]);
  assert.doesNotMatch(result.stdout, /目前處理進度/);
});

test('V0.29.19 subagentStatusLine stays quiet on malformed or empty input', async () => {
  const malformed = await runClient('{bad json');
  assert.equal(malformed.code, 0);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr, '');

  const empty = await runClient({ tasks: [] });
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, '');
  assert.equal(empty.stderr, '');
});
