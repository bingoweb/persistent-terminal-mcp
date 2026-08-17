import test from 'node:test';
import assert from 'node:assert/strict';

import { TRANSFER_TOOLS, callTransferTool } from '../src/transfer-tools.mjs';
import { parseRsyncStats } from '../src/transfer-runner.mjs';

const CAPABILITIES = {
  local: {
    rsync: { available: true, path: '/opt/bin/rsync' },
    scp: { available: true, path: '/usr/bin/scp' },
  },
  remote: {
    rsync: { available: true, path: '/usr/bin/rsync' },
  },
};

function syncTool() {
  const found = TRANSFER_TOOLS.find((item) => item.name === 'remote_sync');
  assert.ok(found, 'missing remote_sync');
  return found;
}

test('remote_sync publishes explicit rsync direction and destructive/dry-run controls', () => {
  const item = syncTool();
  assert.deepEqual(item.inputSchema.required, ['target', 'local_path', 'remote_path', 'direction']);
  assert.deepEqual(item.inputSchema.properties.direction.enum, ['upload', 'download']);
  assert.equal(item.inputSchema.properties.recursive.default, false);
  assert.equal(item.inputSchema.properties.delete.default, false);
  assert.equal(item.inputSchema.properties.dry_run.default, false);
  assert.equal(item.inputSchema.properties.exclude.type, 'array');

  const success = item.outputSchema.oneOf[0];
  assert.deepEqual(success.required, [
    'method',
    'direction',
    'bytes_transferred',
    'files_transferred',
    'dry_run',
    'delete',
    'duration_ms',
  ]);
});

test('remote_sync upload maps delete, excludes, dry-run and recursive to rsync argv', async () => {
  const calls = [];
  const result = await callTransferTool('remote_sync', {
    target: 'taylan',
    local_path: 'local dir/',
    remote_path: '/tmp/remote dir/',
    direction: 'upload',
    recursive: true,
    delete: true,
    dry_run: true,
    exclude: ['*.tmp', '--private *'],
  }, {
    detectTransferCapabilitiesImpl: async () => CAPABILITIES,
    runTransferProcessImpl: async (executable, args) => {
      calls.push({ executable, args });
      return {
        exitCode: 0,
        durationMs: 33,
        bytesTransferred: 2048,
        filesTransferred: 3,
        resumed: false,
      };
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    method: 'rsync',
    direction: 'upload',
    bytes_transferred: 2048,
    files_transferred: 3,
    dry_run: true,
    delete: true,
    duration_ms: 33,
  });
  assert.deepEqual(calls, [{
    executable: '/opt/bin/rsync',
    args: [
      '--secluded-args',
      '--info=progress2',
      '--stats',
      '--recursive',
      '--delete',
      '--dry-run',
      '--exclude=*.tmp',
      '--exclude=--private *',
      '--',
      'local dir/',
      'taylan:/tmp/remote dir/',
    ],
  }]);
});

test('remote_sync download reverses operands and does not invent recursive/delete flags', async () => {
  const calls = [];
  const result = await callTransferTool('remote_sync', {
    target: 'box',
    local_path: 'download dir/',
    remote_path: '/srv/source dir/',
    direction: 'download',
  }, {
    detectTransferCapabilitiesImpl: async () => CAPABILITIES,
    runTransferProcessImpl: async (executable, args) => {
      calls.push({ executable, args });
      return {
        exitCode: 0,
        durationMs: 14,
        bytesTransferred: 512,
        filesTransferred: 1,
        resumed: false,
      };
    },
  });

  assert.deepEqual(result.structuredContent, {
    method: 'rsync',
    direction: 'download',
    bytes_transferred: 512,
    files_transferred: 1,
    dry_run: false,
    delete: false,
    duration_ms: 14,
  });
  assert.deepEqual(calls, [{
    executable: '/opt/bin/rsync',
    args: [
      '--secluded-args',
      '--info=progress2',
      '--stats',
      '--',
      'box:/srv/source dir/',
      'download dir/',
    ],
  }]);
});

test('remote_sync fails with missing_remote_capability when remote rsync is absent', async () => {
  let ran = false;
  const result = await callTransferTool('remote_sync', {
    target: 'box',
    local_path: 'source',
    remote_path: '/tmp/dest',
    direction: 'upload',
  }, {
    detectTransferCapabilitiesImpl: async () => ({
      ...CAPABILITIES,
      remote: { rsync: { available: false, path: null } },
    }),
    runTransferProcessImpl: async () => {
      ran = true;
      throw new Error('must not run');
    },
  });

  assert.equal(ran, false);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.category, 'missing_remote_capability');
  assert.equal(result.structuredContent.details.capability, 'rsync');
});

test('rsync stats parser extracts bounded transferred file and byte counts', () => {
  const text = [
    'Number of regular files transferred: 7',
    'Total transferred file size: 12,345 bytes',
  ].join('\n');
  assert.deepEqual(parseRsyncStats(text), {
    filesTransferred: 7,
    bytesTransferred: 12345,
  });
  assert.deepEqual(parseRsyncStats('not stats'), {
    filesTransferred: 0,
    bytesTransferred: 0,
  });
});
