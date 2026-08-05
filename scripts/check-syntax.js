import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function collect(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collect(full));
    else if (entry.name.endsWith('.js')) output.push(full);
  }
  return output;
}

const files = [...await collect('src'), ...await collect('test'), ...await collect('scripts')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
