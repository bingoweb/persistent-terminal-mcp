import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  detectTransferCapabilities,
  findLocalExecutable,
} from '../src/transfer-capabilities.mjs';
import { createTransferResult } from '../src/transfer-result.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-transfer-capabilities-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('findLocalExecutable searches PATH entries and requires an executable file', async (t) => {
  const root = await tempDir(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'rsync'), '#!/bin/sh\n');
  await fs.chmod(path.join(first, 'rsync'), 0o644);
  await fs.writeFile(path.join(second, 'rsync'), '#!/bin/sh\n');
  await fs.chmod(path.join(second, 'rsync'), 0o755);

  assert.equal(
    await findLocalExecutable('rsync', { pathEnv: `${first}${path.delimiter}${second}` }),
    path.join(second, 'rsync'),
  );
  assert.equal(
    await findLocalExecutable('scp', { pathEnv: `${first}${path.delimiter}${second}` }),
    null,
  );
});

test('detectTransferCapabilities probes local rsync/scp and remote rsync through remote_exec', async () => {
  const local = new Map([
    ['rsync', '/opt/bin/rsync'],
    ['scp', '/usr/bin/scp'],
  ]);
  const calls = [];

  const result = await detectTransferCapabilities('taylan', {
    findLocalExecutableImpl: async (name) => local.get(name) ?? null,
    remoteExecImpl: async (request) => {
      calls.push(request);
      return {
        exit_code: 0,
        stdout: '/usr/bin/rsync\n',
        stderr: '',
        duration_ms: 4,
        timed_out: false,
        truncated: false,
      };
    },
  });

  assert.deepEqual(result, {
    local: {
      rsync: { available: true, path: '/opt/bin/rsync' },
      scp: { available: true, path: '/usr/bin/scp' },
    },
    remote: {
      rsync: { available: true, path: '/usr/bin/rsync' },
    },
  });
  assert.deepEqual(calls, [{
    target: 'taylan',
    command: 'command -v rsync',
    timeout_ms: 5000,
    max_output_bytes: 1024,
  }]);
});

test('remote rsync probe reports unavailable on ordinary non-zero exit', async () => {
  const result = await detectTransferCapabilities('box', {
    findLocalExecutableImpl: async () => null,
    remoteExecImpl: async () => ({
      exit_code: 1,
      stdout: '',
      stderr: '',
      duration_ms: 2,
      timed_out: false,
      truncated: false,
    }),
  });

  assert.deepEqual(result, {
    local: {
      rsync: { available: false, path: null },
      scp: { available: false, path: null },
    },
    remote: {
      rsync: { available: false, path: null },
    },
  });
});

test('transfer result uses the stable normalized public contract', () => {
  assert.deepEqual(createTransferResult({
    method: 'rsync',
    bytesTotal: 1048576,
    bytesTransferred: 524288,
    resumed: true,
    resumeSupported: true,
    verifiedSha256: true,
    durationMs: 125.5,
  }), {
    method: 'rsync',
    bytes_total: 1048576,
    bytes_transferred: 524288,
    resumed: true,
    resume_supported: true,
    verified_sha256: true,
    duration_ms: 125.5,
  });
});

test('transfer result supplies safe zero/false defaults for optional progress fields', () => {
  assert.deepEqual(createTransferResult({ method: 'scp' }), {
    method: 'scp',
    bytes_total: 0,
    bytes_transferred: 0,
    resumed: false,
    resume_supported: false,
    verified_sha256: false,
    duration_ms: 0,
  });
});
