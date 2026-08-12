import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/version.js';

test('V0.29.3 runtime and npm metadata match the release', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, '0.29.3');
  assert.equal(packageJson.version, '0.29.3');
});
