#!/usr/bin/env node

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function cleanRowText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowContent(task) {
  return cleanRowText(task?.description)
    || cleanRowText(task?.label)
    || cleanRowText(task?.name)
    || cleanRowText(task?.type);
}

async function main() {
  const input = await readStdin();
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  const lines = [];
  for (const task of tasks) {
    const id = typeof task?.id === 'string' ? task.id.trim() : '';
    const content = rowContent(task);
    if (!id || !content) continue;
    lines.push(JSON.stringify({ id, content }));
  }
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch(() => {});
