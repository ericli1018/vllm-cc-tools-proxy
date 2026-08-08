import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/version.js';

test('V0.2.25.2 runtime and npm metadata match the hotfix release', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, '0.2.25.2');
  assert.equal(packageJson.version, '0.2.25+hotfix.2');
});
