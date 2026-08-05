import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/lib/process.js';

test('runCommand executes an argument array without a shell', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a;echo injected'], { timeoutMs: 5000 });
  assert.equal(result.stdout.toString(), 'a;echo injected');
});

test('runCommand enforces timeout', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 }),
    /timed out/,
  );
});
