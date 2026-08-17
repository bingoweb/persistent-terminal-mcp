import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSFER_TOOLS,
  callTransferTool,
} from '../src/transfer-tools.mjs';
import { parseRsyncProgress } from '../src/transfer-runner.mjs';
import { buildToolCatalog, callTool } from '../src/tool-registry.mjs';

function tool(name) {
  const found = TRANSFER_TOOLS.find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

const ALL_CAPABILITIES = {
  local: {
    rsync: { available: true, path: '/opt/bin/rsync' },
    scp: { available: true, path: '/usr/bin/scp' },
  },
  remote: {
    rsync: { available: true, path: '/usr/bin/rsync' },
  },
};

test('remote_upload and remote_download publish path-only transfer schemas', () => {
  for (const name of ['remote_upload', 'remote_download']) {
    const item = tool(name);
    assert.deepEqual(item.inputSchema.required, ['target', 'local_path', 'remote_path']);
    for (const field of ['recursive', 'preserve', 'resume', 'verify_sha256']) {
      assert.equal(item.inputSchema.properties[field].type, 'boolean');
      assert.equal(item.inputSchema.properties[field].default, false);
    }
    const success = item.outputSchema.oneOf[0];
    assert.deepEqual(success.required, [
      'method',
      'bytes_total',
      'bytes_transferred',
      'resumed',
      'resume_supported',
      'verified_sha256',
      'duration_ms',
    ]);
  }
});

test('simple upload uses scp argv with an option terminator for -- prefixed and spaced paths', async () => {
  const calls = [];
  const result = await callTransferTool('remote_upload', {
    target: 'taylan',
    local_path: '--payload with spaces.bin',
    remote_path: '/tmp/--remote payload.bin',
    preserve: true,
  }, {
    detectTransferCapabilitiesImpl: async () => ALL_CAPABILITIES,
    statLocalPathImpl: async () => ({ isDirectory: () => false, size: 1234 }),
    runTransferProcessImpl: async (executable, args) => {
      calls.push({ executable, args });
      return { exitCode: 0, durationMs: 12, bytesTransferred: 0, resumed: false };
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    method: 'scp',
    bytes_total: 1234,
    bytes_transferred: 1234,
    resumed: false,
    resume_supported: false,
    verified_sha256: false,
    duration_ms: 12,
  });
  assert.deepEqual(calls, [{
    executable: '/usr/bin/scp',
    args: ['-p', '--', '--payload with spaces.bin', 'taylan:/tmp/--remote payload.bin'],
  }]);
});

test('simple download keeps remote and local spaced paths as distinct scp argv values', async () => {
  const calls = [];
  const result = await callTransferTool('remote_download', {
    target: 'taylan',
    local_path: '--download target.bin',
    remote_path: '/tmp/source with spaces.bin',
  }, {
    detectTransferCapabilitiesImpl: async () => ALL_CAPABILITIES,
    statLocalPathImpl: async () => ({ isDirectory: () => false, size: 987 }),
    runTransferProcessImpl: async (executable, args) => {
      calls.push({ executable, args });
      return { exitCode: 0, durationMs: 9, bytesTransferred: 0, resumed: false };
    },
  });

  assert.deepEqual(result.structuredContent, {
    method: 'scp',
    bytes_total: 987,
    bytes_transferred: 987,
    resumed: false,
    resume_supported: false,
    verified_sha256: false,
    duration_ms: 9,
  });
  assert.deepEqual(calls, [{
    executable: '/usr/bin/scp',
    args: ['--', 'taylan:/tmp/source with spaces.bin', '--download target.bin'],
  }]);
});

test('resume upload requires rsync and uses secluded args, partial state and progress2', async () => {
  const calls = [];
  const result = await callTransferTool('remote_upload', {
    target: 'box',
    local_path: 'local file.bin',
    remote_path: '/tmp/--remote file.bin',
    recursive: true,
    preserve: true,
    resume: true,
  }, {
    detectTransferCapabilitiesImpl: async () => ALL_CAPABILITIES,
    statLocalPathImpl: async () => ({ isDirectory: () => true, size: 4096 }),
    runTransferProcessImpl: async (executable, args) => {
      calls.push({ executable, args });
      return { exitCode: 0, durationMs: 21, bytesTransferred: 4096, resumed: true };
    },
  });

  assert.deepEqual(result.structuredContent, {
    method: 'rsync',
    bytes_total: 0,
    bytes_transferred: 4096,
    resumed: true,
    resume_supported: true,
    verified_sha256: false,
    duration_ms: 21,
  });
  assert.deepEqual(calls, [{
    executable: '/opt/bin/rsync',
    args: [
      '--secluded-args',
      '--partial',
      '--info=progress2',
      '--recursive',
      '--perms',
      '--times',
      '--',
      'local file.bin',
      'box:/tmp/--remote file.bin',
    ],
  }]);
});

test('resume upload reports resumed true only when a pre-existing remote partial file is observed', async () => {
  const result = await callTransferTool('remote_upload', {
    target: 'box',
    local_path: 'large.bin',
    remote_path: '/tmp/large.bin',
    resume: true,
  }, {
    detectTransferCapabilitiesImpl: async () => ALL_CAPABILITIES,
    statLocalPathImpl: async () => ({ isDirectory: () => false, size: 8192 }),
    statRemotePathImpl: async () => ({ path: '/tmp/large.bin', type: 'file', size: 2048 }),
    runTransferProcessImpl: async () => ({
      exitCode: 0,
      durationMs: 31,
      bytesTransferred: 6144,
      bytesTotal: 8192,
      resumed: false,
    }),
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.resumed, true);
  assert.equal(result.structuredContent.resume_supported, true);
});

test('rsync progress parser returns the latest bounded byte count without log text', () => {
  assert.deepEqual(
    parseRsyncProgress('  1,024  25%  1.00MB/s\r  4,096 100%  2.00MB/s\n'),
    { bytesTransferred: 4096, bytesTotal: 4096 },
  );
  assert.deepEqual(parseRsyncProgress('no progress here'), {
    bytesTransferred: 0,
    bytesTotal: 0,
  });
});

test('transfer tools are published and routed locally by the unified registry', async () => {
  const catalog = buildToolCatalog({ upstreamTools: [] });
  assert(catalog.some((item) => item.name === 'remote_upload'));
  assert(catalog.some((item) => item.name === 'remote_download'));

  const expected = { structuredContent: { sentinel: true }, content: [] };
  const calls = [];
  const returned = await callTool('remote_upload', { target: 'box' }, {
    upstreamClient: { callTool: async () => { throw new Error('must not forward upstream'); } },
    upstreamToolNames: new Set(),
    transferToolCallImpl: async (name, args) => {
      calls.push({ name, args });
      return expected;
    },
  });

  assert.strictEqual(returned, expected);
  assert.deepEqual(calls, [{ name: 'remote_upload', args: { target: 'box' } }]);
});
