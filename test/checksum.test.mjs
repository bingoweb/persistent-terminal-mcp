import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  hashLocalFile,
  readRemoteSha256,
  verifyTransferSha256,
} from '../src/checksum.mjs';
import { callTransferTool } from '../src/transfer-tools.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

async function tempFile(t, contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-checksum-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'payload.bin');
  await fs.writeFile(file, contents);
  return file;
}

test('hashLocalFile streams a file into SHA-256 without returning file bytes', async (t) => {
  const file = await tempFile(t, Buffer.from('abc', 'utf8'));
  assert.equal(
    await hashLocalFile(file),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('readRemoteSha256 keeps the remote path in structured env instead of command interpolation', async () => {
  const calls = [];
  const remotePath = `/tmp/--payload with spaces and 'quotes'.bin`;
  const digest = await readRemoteSha256('taylan', remotePath, {
    remoteExecImpl: async (request) => {
      calls.push(request);
      return {
        exit_code: 0,
        stdout: `${SHA_A}  ${remotePath}\n`,
        stderr: '',
        duration_ms: 3,
        timed_out: false,
        truncated: false,
      };
    },
  });

  assert.equal(digest, SHA_A);
  assert.deepEqual(calls, [{
    target: 'taylan',
    command: 'sha256sum -- "$PERSISTENT_TERMINAL_SHA_PATH"',
    env: { PERSISTENT_TERMINAL_SHA_PATH: remotePath },
    timeout_ms: 60000,
    max_output_bytes: 4096,
  }]);
  assert.equal(calls[0].command.includes(remotePath), false);
});

test('verifyTransferSha256 throws checksum_integrity_failure and exposes both hashes only on mismatch', async () => {
  await assert.rejects(
    () => verifyTransferSha256({
      target: 'box',
      localPath: '/tmp/local.bin',
      remotePath: '/tmp/remote.bin',
    }, {
      hashLocalFileImpl: async () => SHA_A,
      readRemoteSha256Impl: async () => SHA_B,
    }),
    (error) => {
      assert.equal(error.category, 'checksum_integrity_failure');
      assert.equal(error.details.local_sha256, SHA_A);
      assert.equal(error.details.remote_sha256, SHA_B);
      assert.equal(error.details.local_path, '/tmp/local.bin');
      assert.equal(error.details.remote_path, '/tmp/remote.bin');
      return true;
    },
  );
});

test('verifyTransferSha256 returns only verified_sha256 on success', async () => {
  assert.deepEqual(await verifyTransferSha256({
    target: 'box',
    localPath: '/tmp/local.bin',
    remotePath: '/tmp/remote.bin',
  }, {
    hashLocalFileImpl: async () => SHA_A,
    readRemoteSha256Impl: async () => SHA_A,
  }), {
    verified_sha256: true,
  });
});

test('remote_upload with verify_sha256 runs post-transfer verification and reports success without hashes', async () => {
  const verificationCalls = [];
  const capabilities = {
    local: {
      rsync: { available: true, path: '/opt/bin/rsync' },
      scp: { available: true, path: '/usr/bin/scp' },
    },
    remote: { rsync: { available: true, path: '/usr/bin/rsync' } },
  };

  const result = await callTransferTool('remote_upload', {
    target: 'box',
    local_path: '/tmp/local.bin',
    remote_path: '/tmp/remote.bin',
    verify_sha256: true,
  }, {
    detectTransferCapabilitiesImpl: async () => capabilities,
    statLocalPathImpl: async () => ({ isDirectory: () => false, size: 99 }),
    runTransferProcessImpl: async () => ({
      exitCode: 0,
      durationMs: 4,
      bytesTransferred: 0,
      resumed: false,
    }),
    verifyTransferSha256Impl: async (request) => {
      verificationCalls.push(request);
      return { verified_sha256: true };
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.verified_sha256, true);
  assert.equal('local_sha256' in result.structuredContent, false);
  assert.equal('remote_sha256' in result.structuredContent, false);
  assert.deepEqual(verificationCalls, [{
    target: 'box',
    localPath: '/tmp/local.bin',
    remotePath: '/tmp/remote.bin',
  }]);
});

test('remote_download verifies the downloaded local destination against the remote source', async () => {
  const verificationCalls = [];
  const capabilities = {
    local: {
      rsync: { available: true, path: '/opt/bin/rsync' },
      scp: { available: true, path: '/usr/bin/scp' },
    },
    remote: { rsync: { available: true, path: '/usr/bin/rsync' } },
  };

  const result = await callTransferTool('remote_download', {
    target: 'box',
    local_path: '/tmp/downloaded.bin',
    remote_path: '/tmp/source.bin',
    verify_sha256: true,
  }, {
    detectTransferCapabilitiesImpl: async () => capabilities,
    statLocalPathImpl: async () => ({ isDirectory: () => false, size: 123 }),
    runTransferProcessImpl: async () => ({ exitCode: 0, durationMs: 8, bytesTransferred: 0, resumed: false }),
    verifyTransferSha256Impl: async (request) => {
      verificationCalls.push(request);
      return { verified_sha256: true };
    },
  });

  assert.equal(result.structuredContent.verified_sha256, true);
  assert.deepEqual(verificationCalls, [{
    target: 'box',
    localPath: '/tmp/downloaded.bin',
    remotePath: '/tmp/source.bin',
  }]);
});
