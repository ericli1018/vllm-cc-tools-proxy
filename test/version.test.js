import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/version.js';

test('V0.2.23.2 runtime label and npm hotfix metadata are intentional', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, '0.2.23.2');
  assert.equal(packageJson.version, '0.2.23+hotfix.2');
});
