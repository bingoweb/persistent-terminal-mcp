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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-remote-patch-'));
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

test('remote_patch schema exposes exact deterministic hunks', () => {
  const tool = REMOTE_FS_TOOLS.find((item) => item.name === 'remote_patch');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['target', 'path', 'hunks']);
  assert.equal(tool.inputSchema.properties.expected_sha256.pattern, '^[0-9a-f]{64}$');
  assert.equal(tool.inputSchema.properties.hunks.minItems, 1);
  assert.deepEqual(
    tool.inputSchema.properties.hunks.items.required,
    ['old_text', 'new_text', 'expected_count'],
  );
  assert.equal(tool.inputSchema.properties.hunks.items.properties.expected_count.minimum, 1);
});

test('remote_patch maps directly to the helper patch operation', async () => {
  const calls = [];
  const args = {
    target: 'box',
    path: '/tmp/example.txt',
    expected_sha256: 'a'.repeat(64),
    hunks: [{ old_text: 'before', new_text: 'after', expected_count: 1 }],
  };
  const expected = { path: args.path, size: 5, sha256: 'b'.repeat(64), hunks_applied: 1 };

  const result = await callRemoteFsTool('remote_patch', args, {
    callRemoteFsImpl: async (target, request) => {
      calls.push({ target, request });
      return expected;
    },
  });

  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(calls, [{
    target: 'box',
    request: {
      op: 'patch',
      path: args.path,
      expected_sha256: args.expected_sha256,
      hunks: args.hunks,
    },
  }]);
});

test('exact single replacement patches text and reports the new hash', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'example.txt');
  await fs.writeFile(file, 'alpha before omega\n', 'utf8');
  const before = await runHelper({ op: 'read', path: file });

  const patched = await runHelper({
    op: 'patch',
    path: file,
    expected_sha256: before.result.sha256,
    hunks: [{ old_text: 'before', new_text: 'after', expected_count: 1 }],
  });

  assert.equal(patched.ok, true);
  assert.equal(patched.result.path, file);
  assert.equal(patched.result.hunks_applied, 1);
  assert.match(patched.result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(file, 'utf8'), 'alpha after omega\n');
});

test('unexpected hunk match count fails before writing and reports hunk details', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'count.txt');
  const original = 'same same\n';
  await fs.writeFile(file, original, 'utf8');

  const result = await runHelper({
    op: 'patch',
    path: file,
    hunks: [{ old_text: 'same', new_text: 'changed', expected_count: 1 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, 'checksum_integrity_failure');
  assert.deepEqual(result.error.details, {
    path: file,
    hunk_index: 0,
    expected_count: 1,
    actual_count: 2,
  });
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('hash conflict prevents every hunk from being applied', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'hash.txt');
  const original = 'before\n';
  await fs.writeFile(file, original, 'utf8');

  const result = await runHelper({
    op: 'patch',
    path: file,
    expected_sha256: '0'.repeat(64),
    hunks: [{ old_text: 'before', new_text: 'after', expected_count: 1 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, 'checksum_integrity_failure');
  assert.equal(result.error.details.path, file);
  assert.equal(result.error.details.expected_sha256, '0'.repeat(64));
  assert.match(result.error.details.actual_sha256, /^[0-9a-f]{64}$/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('a later hunk failure leaves the original file unchanged', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'multi.txt');
  const original = 'first second\n';
  await fs.writeFile(file, original, 'utf8');

  const result = await runHelper({
    op: 'patch',
    path: file,
    hunks: [
      { old_text: 'first', new_text: 'FIRST', expected_count: 1 },
      { old_text: 'missing', new_text: 'MISSING', expected_count: 1 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.details.hunk_index, 1);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('atomic write failure preserves the original file contents', async (t) => {
  const dir = await tempDir(t);
  const protectedDir = path.join(dir, 'protected');
  const file = path.join(protectedDir, 'atomic.txt');
  const original = 'before\n';
  await fs.mkdir(protectedDir);
  await fs.writeFile(file, original, 'utf8');
  await fs.chmod(protectedDir, 0o500);

  try {
    const result = await runHelper({
      op: 'patch',
      path: file,
      hunks: [{ old_text: 'before', new_text: 'after', expected_count: 1 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.category, 'permission_privilege_error');
    assert.equal(await fs.readFile(file, 'utf8'), original);
  } finally {
    await fs.chmod(protectedDir, 0o700);
  }
});
