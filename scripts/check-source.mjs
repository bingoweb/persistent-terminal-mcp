import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['src', 'test', 'scripts'];

async function collectMjs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectMjs(target));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(target);
  }
  return files;
}

const files = [];
for (const root of roots) {
  const dir = path.join(rootDir, root);
  try {
    files.push(...await collectMjs(dir));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

for (const file of files.sort()) {
  await execFileAsync(process.execPath, ['--check', file], { cwd: rootDir });
}

process.stdout.write(`SOURCE_CHECK_OK (${files.length} files)\n`);
