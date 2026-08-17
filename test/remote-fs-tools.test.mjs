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
import { buildToolCatalog, callTool } from '../src/tool-registry.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(TEST_DIR, '../helpers/remote_fs.py');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-remote-fs-'));
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
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function tool(name) {
  const found = REMOTE_FS_TOOLS.find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

test('Task 2 base filesystem tools remain available as canonical operations', () => {
  const names = new Set(REMOTE_FS_TOOLS.map((item) => item.name));
  for (const name of [
    'remote_stat',
    'remote_list',
    'remote_read',
    'remote_write',
    'remote_mkdir',
    'remote_move',
    'remote_delete',
  ]) {
    assert.equal(names.has(name), true, `missing ${name}`);
  }
});

test('remote file tool schemas require target plus operation-specific paths', () => {
  assert.deepEqual(tool('remote_stat').inputSchema.required, ['target', 'path']);
  assert.deepEqual(tool('remote_list').inputSchema.required, ['target', 'path']);
  assert.deepEqual(tool('remote_read').inputSchema.required, ['target', 'path']);
  assert.deepEqual(tool('remote_write').inputSchema.required, ['target', 'path', 'text']);
  assert.deepEqual(tool('remote_mkdir').inputSchema.required, ['target', 'path']);
  assert.deepEqual(tool('remote_move').inputSchema.required, ['target', 'source_path', 'destination_path']);
  assert.deepEqual(tool('remote_delete').inputSchema.required, ['target', 'path']);
  assert.equal(tool('remote_write').inputSchema.properties.expected_sha256.pattern, '^[0-9a-f]{64}$');
  assert.equal(tool('remote_delete').inputSchema.properties.recursive.default, false);
});

test('callRemoteFsTool maps canonical tools to helper operations without shell adaptation', async () => {
  const calls = [];
  const callRemoteFsImpl = async (target, request) => {
    calls.push({ target, request });
    return { echoed: request.op };
  };

  const cases = [
    ['remote_stat', { target: 'box', path: '/a' }, { op: 'stat', path: '/a' }],
    ['remote_list', { target: 'box', path: '/a' }, { op: 'list', path: '/a' }],
    ['remote_read', { target: 'box', path: '/a' }, { op: 'read', path: '/a' }],
    ['remote_write', { target: 'box', path: '/a', text: 'x', expected_sha256: 'a'.repeat(64) }, {
      op: 'write', path: '/a', text: 'x', expected_sha256: 'a'.repeat(64),
    }],
    ['remote_mkdir', { target: 'box', path: '/a', parents: true }, { op: 'mkdir', path: '/a', parents: true }],
    ['remote_move', { target: 'box', source_path: '/a', destination_path: '/b' }, {
      op: 'move', source_path: '/a', destination_path: '/b',
    }],
    ['remote_delete', { target: 'box', path: '/a', recursive: true }, { op: 'delete', path: '/a', recursive: true }],
  ];

  for (const [name, args, request] of cases) {
    const result = await callRemoteFsTool(name, args, { callRemoteFsImpl });
    assert.equal(result.structuredContent.echoed, request.op);
    assert.deepEqual(calls.at(-1), { target: 'box', request });
  }
});

test('unified MCP catalog publishes all seven remote filesystem tools', () => {
  const catalog = buildToolCatalog({ upstreamTools: [] });
  for (const item of REMOTE_FS_TOOLS) {
    const published = catalog.find((candidate) => candidate.name === item.name);
    const { annotations, ...base } = published;
    assert.deepEqual(base, item);
    assert.equal(typeof annotations.readOnlyHint, 'boolean');
    assert.equal(typeof annotations.destructiveHint, 'boolean');
    assert.equal(typeof annotations.idempotentHint, 'boolean');
    assert.equal(typeof annotations.openWorldHint, 'boolean');
  }
});

test('callTool routes remote filesystem names locally instead of forwarding upstream', async () => {
  const calls = [];
  const expected = {
    content: [{ type: 'text', text: '{"path":"/tmp/example"}' }],
    structuredContent: { path: '/tmp/example' },
  };

  const result = await callTool('remote_stat', { target: 'box', path: '/tmp/example' }, {
    upstreamClient: { callTool: async () => { throw new Error('must not forward upstream'); } },
    upstreamToolNames: new Set(),
    remoteExecImpl: async () => { throw new Error('must not use remote_exec tool handler'); },
    sessionToolCallImpl: async () => { throw new Error('must not use session layer'); },
    remoteFsToolCallImpl: async (name, args) => {
      calls.push({ name, args });
      return expected;
    },
  });

  assert.strictEqual(result, expected);
  assert.deepEqual(calls, [{
    name: 'remote_stat',
    args: { target: 'box', path: '/tmp/example' },
  }]);
});

test('stat returns normalized metadata and list is sorted by name', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'z.txt'), 'z');
  await fs.writeFile(path.join(dir, 'a.txt'), 'a');

  const stat = await runHelper({ op: 'stat', path: path.join(dir, 'a.txt') });
  assert.equal(stat.ok, true);
  assert.equal(stat.result.path, path.join(dir, 'a.txt'));
  assert.equal(stat.result.type, 'file');
  assert.equal(stat.result.size, 1);
  assert.match(stat.result.mode, /^[0-7]{4}$/);
  assert.equal(Number.isInteger(stat.result.uid), true);
  assert.equal(Number.isInteger(stat.result.gid), true);
  assert.equal(typeof stat.result.mtime, 'number');

  const listed = await runHelper({ op: 'list', path: dir });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.entries.map((entry) => entry.name), ['a.txt', 'z.txt']);
  assert.deepEqual(listed.result.entries.map((entry) => entry.type), ['file', 'file']);
});

test('read returns UTF-8 text plus SHA-256 and rejects binary files', async (t) => {
  const dir = await tempDir(t);
  const textPath = path.join(dir, 'utf8.txt');
  const binaryPath = path.join(dir, 'binary.bin');
  await fs.writeFile(textPath, 'Merhaba dünya\n', 'utf8');
  await fs.writeFile(binaryPath, Buffer.from([0x41, 0x00, 0x42]));

  const read = await runHelper({ op: 'read', path: textPath });
  assert.equal(read.ok, true);
  assert.equal(read.result.text, 'Merhaba dünya\n');
  assert.match(read.result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(read.result.size, Buffer.byteLength('Merhaba dünya\n'));

  const binary = await runHelper({ op: 'read', path: binaryPath });
  assert.equal(binary.ok, false);
  assert.equal(binary.error.category, 'binary_file');
  assert.equal(binary.error.details.path, binaryPath);
});

test('write is atomic, preserves existing mode, and enforces expected_sha256', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.txt');
  await fs.writeFile(file, 'before', 'utf8');
  await fs.chmod(file, 0o640);

  const before = await runHelper({ op: 'read', path: file });
  const written = await runHelper({
    op: 'write',
    path: file,
    text: 'after',
    expected_sha256: before.result.sha256,
  });
  assert.equal(written.ok, true);
  assert.equal(written.result.path, file);
  assert.equal(written.result.created, false);
  assert.equal(written.result.size, 5);
  assert.match(written.result.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(file, 'utf8'), 'after');

  const conflict = await runHelper({
    op: 'write',
    path: file,
    text: 'must-not-land',
    expected_sha256: '0'.repeat(64),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.category, 'checksum_integrity_failure');
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('write rejects NUL-containing text as binary content', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'nul.txt');
  const result = await runHelper({ op: 'write', path: file, text: 'a\0b' });
  assert.equal(result.ok, false);
  assert.equal(result.error.category, 'binary_file');
  await assert.rejects(() => fs.stat(file), /ENOENT/);
});

test('mkdir, move, and delete report exact affected paths', async (t) => {
  const dir = await tempDir(t);
  const nested = path.join(dir, 'one', 'two');
  const made = await runHelper({ op: 'mkdir', path: nested, parents: true });
  assert.deepEqual(made.result, { path: nested, created: true });

  const source = path.join(nested, 'source.txt');
  const destination = path.join(nested, 'destination.txt');
  await fs.writeFile(source, 'move me');
  const moved = await runHelper({ op: 'move', source_path: source, destination_path: destination });
  assert.deepEqual(moved.result, {
    source_path: source,
    destination_path: destination,
    moved: true,
  });
  assert.equal(await fs.readFile(destination, 'utf8'), 'move me');

  const deleted = await runHelper({ op: 'delete', path: destination });
  assert.deepEqual(deleted.result, { path: destination, type: 'file', deleted: true });
});

test('non-empty directory deletion requires recursive true', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'non-empty');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'child.txt'), 'x');

  const refused = await runHelper({ op: 'delete', path: target });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.category, 'validation_error');
  assert.equal(refused.error.details.path, target);

  const deleted = await runHelper({ op: 'delete', path: target, recursive: true });
  assert.deepEqual(deleted.result, { path: target, type: 'directory', deleted: true });
  await assert.rejects(() => fs.stat(target), /ENOENT/);
});
