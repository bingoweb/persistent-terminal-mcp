import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  REMOTE_FS_TOOLS,
  callRemoteFsTool,
} from '../src/remote-fs-tools.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(TEST_DIR, '../helpers/remote_fs.py');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-remote-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function runHelper(request) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`helper exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function tool(name) {
  const found = REMOTE_FS_TOOLS.find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

test('remote_find and remote_grep publish bounded canonical schemas', () => {
  const find = tool('remote_find');
  const grep = tool('remote_grep');

  assert.deepEqual(find.inputSchema.required, ['target', 'path']);
  assert.equal(find.inputSchema.properties.name_pattern.default, '*');
  assert.equal(find.inputSchema.properties.max_depth.minimum, 0);
  assert.equal(find.inputSchema.properties.max_results.minimum, 1);
  assert.equal(find.inputSchema.properties.max_bytes.minimum, 1);

  assert.deepEqual(grep.inputSchema.required, ['target', 'path', 'pattern']);
  assert.equal(grep.inputSchema.properties.max_depth.minimum, 0);
  assert.equal(grep.inputSchema.properties.max_results.minimum, 1);
  assert.equal(grep.inputSchema.properties.max_bytes.minimum, 1);
});

test('search tools map directly to fixed helper operations', async () => {
  const calls = [];
  const findArgs = {
    target: 'box',
    path: '/tmp/root',
    name_pattern: '*.txt',
    max_depth: 3,
    max_results: 20,
    max_bytes: 4096,
  };
  const grepArgs = {
    target: 'box',
    path: '/tmp/root',
    pattern: '^needle',
    max_depth: 2,
    max_results: 10,
    max_bytes: 2048,
  };

  await callRemoteFsTool('remote_find', findArgs, {
    callRemoteFsImpl: async (target, request) => {
      calls.push({ target, request });
      return { path: request.path, entries: [], result_count: 0, truncated: false };
    },
  });
  await callRemoteFsTool('remote_grep', grepArgs, {
    callRemoteFsImpl: async (target, request) => {
      calls.push({ target, request });
      return {
        path: request.path,
        matches: [],
        result_count: 0,
        skipped_binary_files: 0,
        truncated: false,
      };
    },
  });

  assert.deepEqual(calls, [
    { target: 'box', request: { op: 'find', ...Object.fromEntries(Object.entries(findArgs).filter(([key]) => key !== 'target')) } },
    { target: 'box', request: { op: 'grep', ...Object.fromEntries(Object.entries(grepArgs).filter(([key]) => key !== 'target')) } },
  ]);
});

test('find uses glob-like basename filtering, deterministic order, and max_depth', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'zeta.txt'), 'z\n');
  await fs.writeFile(path.join(root, 'alpha.txt'), 'a\n');
  await fs.mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
  await fs.writeFile(path.join(root, 'nested', 'beta.txt'), 'b\n');
  await fs.writeFile(path.join(root, 'nested', 'deep', 'gamma.txt'), 'g\n');
  await fs.writeFile(path.join(root, 'nested', 'ignore.log'), 'x\n');

  const result = await runHelper({
    op: 'find',
    path: root,
    name_pattern: '*.txt',
    max_depth: 2,
    max_results: 20,
    max_bytes: 65536,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.truncated, false);
  assert.equal(result.result.result_count, 3);
  assert.deepEqual(
    result.result.entries.map((entry) => entry.path),
    [
      path.join(root, 'alpha.txt'),
      path.join(root, 'nested', 'beta.txt'),
      path.join(root, 'zeta.txt'),
    ],
  );
});

test('find sets truncated when max_results or max_bytes prevents another result', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  await fs.writeFile(path.join(root, 'b.txt'), 'b');
  await fs.writeFile(path.join(root, 'c.txt'), 'c');

  const byCount = await runHelper({
    op: 'find',
    path: root,
    name_pattern: '*.txt',
    max_depth: 1,
    max_results: 2,
    max_bytes: 65536,
  });
  assert.equal(byCount.ok, true);
  assert.equal(byCount.result.result_count, 2);
  assert.equal(byCount.result.truncated, true);

  const byBytes = await runHelper({
    op: 'find',
    path: root,
    name_pattern: '*.txt',
    max_depth: 1,
    max_results: 10,
    max_bytes: 1,
  });
  assert.equal(byBytes.ok, true);
  assert.equal(byBytes.result.result_count, 0);
  assert.equal(byBytes.result.truncated, true);
});

test('grep applies regex per line, reports 1-based line numbers, and counts skipped binary files', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'ok\nERROR first\nno\nERROR second\n');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'b.txt'), 'ERROR nested\n');

  const result = await runHelper({
    op: 'grep',
    path: root,
    pattern: '^ERROR',
    max_depth: 2,
    max_results: 10,
    max_bytes: 65536,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.truncated, false);
  assert.equal(result.result.skipped_binary_files, 1);
  assert.equal(result.result.result_count, 3);
  assert.deepEqual(result.result.matches, [
    { path: path.join(root, 'a.txt'), line_number: 2, line: 'ERROR first' },
    { path: path.join(root, 'a.txt'), line_number: 4, line: 'ERROR second' },
    { path: path.join(root, 'nested', 'b.txt'), line_number: 1, line: 'ERROR nested' },
  ]);
});

test('grep truncates bounded results and never follows directory symlinks', async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'hit one\nhit two\nhit three\n');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'hit outside\n');
  await fs.symlink(outside, path.join(root, 'linked'));

  const result = await runHelper({
    op: 'grep',
    path: root,
    pattern: '^hit',
    max_depth: 4,
    max_results: 2,
    max_bytes: 65536,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.result_count, 2);
  assert.equal(result.result.truncated, true);
  assert.deepEqual(result.result.matches.map((match) => match.line), ['hit one', 'hit two']);
  assert.equal(result.result.matches.some((match) => match.path.includes('secret.txt')), false);
});
