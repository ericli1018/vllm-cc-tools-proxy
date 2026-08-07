import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { VERSION } from '../src/version.js';

test('runtime version matches the package release version', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, '0.2.21-diagnostic.1');
  assert.equal(packageJson.version, '0.2.21-diagnostic.1');
});
