import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { hashLocalFile } from '../../src/checksum.mjs';
import { detectTransferCapabilities } from '../../src/transfer-capabilities.mjs';
import { runTransferProcess } from '../../src/transfer-runner.mjs';

const HOST = process.env.PTY_MCP_SMOKE_HOST;
const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '../..');
const MIB = 1024 * 1024;
const ROUNDTRIP_BYTES = 32 * MIB;
const RESUME_BYTES = 48 * MIB;

function parseToolJson(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error(`tool result has no JSON payload: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text);
}

function assertToolSuccess(result, name) {
  if (result?.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(parseToolJson(result))}`);
  }
  return parseToolJson(result);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeDeterministicFile(filePath, size) {
  const block = Buffer.allocUnsafe(MIB);
  for (let index = 0; index < block.length; index += 1) {
    block[index] = (index * 31 + 17) & 0xff;
  }
  const handle = await fs.open(filePath, 'w');
  try {
    let written = 0;
    while (written < size) {
      const length = Math.min(block.length, size - written);
      await handle.write(block, 0, length, written);
      written += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function run() {
  if (!HOST) {
    throw new Error('PTY_MCP_SMOKE_HOST is required for the live transfer round-trip test');
  }

  const unique = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), `persistent-terminal-transfer-${unique}-`));
  const sourcePath = path.join(localRoot, '--source payload.bin');
  const downloadPath = path.join(localRoot, '--download payload.bin');
  const resumeSourcePath = path.join(localRoot, 'resume-source.bin');
  const syncSourceDir = path.join(localRoot, 'sync-source');
  const remoteRoot = `/tmp/persistent-terminal-transfer-${unique}`;
  const remotePath = `${remoteRoot}/--remote payload.bin`;
  const remoteResumePath = `${remoteRoot}/resume-target.bin`;
  const remoteSyncDir = `${remoteRoot}/sync-target`;

  await writeDeterministicFile(sourcePath, ROUNDTRIP_BYTES);
  await writeDeterministicFile(resumeSourcePath, RESUME_BYTES);
  await fs.mkdir(syncSourceDir);
  await fs.writeFile(path.join(syncSourceDir, 'keep.txt'), 'keep-v1\n');
  await fs.writeFile(path.join(syncSourceDir, 'excluded.tmp'), 'must-not-sync\n');
  const sourceSha256 = await hashLocalFile(sourcePath);
  const resumeSha256 = await hashLocalFile(resumeSourcePath);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.mjs'],
    cwd: PACKAGE_ROOT,
    env: {
      ...(process.env.PTY_UPSTREAM_URL ? { PTY_UPSTREAM_URL: process.env.PTY_UPSTREAM_URL } : {}),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client({
    name: 'persistent-terminal-transfer-live',
    version: '1.0.0',
  });
  let remoteRootCreated = false;
  const call = async (name, arguments_) => client.callTool({ name, arguments: arguments_ });

  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(
        `extension failed to start${stderr ? `: ${stderr.trim()}` : ''}`,
        { cause: error },
      );
    }

    const listed = await client.listTools();
    for (const name of [
      'remote_mkdir',
      'remote_stat',
      'remote_list',
      'remote_write',
      'remote_delete',
      'remote_upload',
      'remote_download',
      'remote_sync',
    ]) {
      assert(listed.tools.some((tool) => tool.name === name), `missing canonical tool ${name}`);
    }

    const created = assertToolSuccess(await call('remote_mkdir', {
      target: HOST,
      path: remoteRoot,
    }), 'remote_mkdir');
    assert(created.created === true, `remote test root was not created: ${JSON.stringify(created)}`);
    remoteRootCreated = true;

    const uploaded = assertToolSuccess(await call('remote_upload', {
      target: HOST,
      local_path: sourcePath,
      remote_path: remotePath,
      verify_sha256: true,
    }), 'remote_upload integrity round-trip');
    assert(uploaded.bytes_total === ROUNDTRIP_BYTES, `upload size mismatch: ${JSON.stringify(uploaded)}`);
    assert(uploaded.verified_sha256 === true, `upload SHA-256 was not verified: ${JSON.stringify(uploaded)}`);

    const downloaded = assertToolSuccess(await call('remote_download', {
      target: HOST,
      local_path: downloadPath,
      remote_path: remotePath,
      verify_sha256: true,
    }), 'remote_download integrity round-trip');
    assert(downloaded.bytes_total === ROUNDTRIP_BYTES, `download size mismatch: ${JSON.stringify(downloaded)}`);
    assert(downloaded.verified_sha256 === true, `download SHA-256 was not verified: ${JSON.stringify(downloaded)}`);
    const downloadedSha256 = await hashLocalFile(downloadPath);
    assert(downloadedSha256 === sourceSha256, 'downloaded file SHA-256 differs from source');

    const capabilities = await detectTransferCapabilities(HOST);
    assert(capabilities.local.rsync.available, 'live resume test requires local rsync');
    assert(capabilities.remote.rsync.available, 'live resume test requires remote rsync');

    let interrupted = false;
    try {
      await runTransferProcess(capabilities.local.rsync.path, [
        '--secluded-args',
        '--partial',
        '--info=progress2',
        '--bwlimit=1024',
        '--',
        resumeSourcePath,
        `${HOST}:${remoteResumePath}`,
      ], { timeoutMs: 1500 });
    } catch (error) {
      if (error?.category !== 'timeout') throw error;
      interrupted = true;
    }
    assert(interrupted, 'controlled rsync transfer completed before interruption');

    const partial = assertToolSuccess(await call('remote_stat', {
      target: HOST,
      path: remoteResumePath,
    }), 'remote_stat partial transfer');
    assert(partial.type === 'file', `partial rsync target is not a file: ${JSON.stringify(partial)}`);
    assert(partial.size > 0 && partial.size < RESUME_BYTES, `partial rsync size is not bounded: ${JSON.stringify(partial)}`);

    const resumed = assertToolSuccess(await call('remote_upload', {
      target: HOST,
      local_path: resumeSourcePath,
      remote_path: remoteResumePath,
      resume: true,
      verify_sha256: true,
    }), 'remote_upload resumed transfer');
    assert(resumed.resume_supported === true, `rsync resume not reported supported: ${JSON.stringify(resumed)}`);
    assert(resumed.resumed === true, `pre-existing partial transfer was not reported resumed: ${JSON.stringify(resumed)}`);
    assert(resumed.verified_sha256 === true, `resumed transfer SHA-256 was not verified: ${JSON.stringify(resumed)}`);

    const resumeRemoteStat = assertToolSuccess(await call('remote_stat', {
      target: HOST,
      path: remoteResumePath,
    }), 'remote_stat resumed target');
    assert(resumeRemoteStat.size === RESUME_BYTES, `resumed target size mismatch: ${JSON.stringify(resumeRemoteStat)}`);

    const resumedDownloadPath = path.join(localRoot, 'resumed-verify-download.bin');
    const resumedDownload = assertToolSuccess(await call('remote_download', {
      target: HOST,
      local_path: resumedDownloadPath,
      remote_path: remoteResumePath,
      verify_sha256: true,
    }), 'remote_download resumed verification');
    assert(resumedDownload.verified_sha256 === true, `resumed target download verification failed: ${JSON.stringify(resumedDownload)}`);
    assert(await hashLocalFile(resumedDownloadPath) === resumeSha256, 'resumed transfer content differs from source');

    assertToolSuccess(await call('remote_mkdir', {
      target: HOST,
      path: remoteSyncDir,
    }), 'remote_mkdir sync target');

    const dryRun = assertToolSuccess(await call('remote_sync', {
      target: HOST,
      local_path: `${syncSourceDir}/`,
      remote_path: `${remoteSyncDir}/`,
      direction: 'upload',
      recursive: true,
      dry_run: true,
      exclude: ['*.tmp'],
    }), 'remote_sync dry-run');
    assert(dryRun.method === 'rsync' && dryRun.dry_run === true, `sync dry-run metadata mismatch: ${JSON.stringify(dryRun)}`);
    const afterDryRun = assertToolSuccess(await call('remote_list', {
      target: HOST,
      path: remoteSyncDir,
    }), 'remote_list after dry-run');
    assert(afterDryRun.entries.length === 0, `dry-run modified remote directory: ${JSON.stringify(afterDryRun)}`);

    const synced = assertToolSuccess(await call('remote_sync', {
      target: HOST,
      local_path: `${syncSourceDir}/`,
      remote_path: `${remoteSyncDir}/`,
      direction: 'upload',
      recursive: true,
      exclude: ['*.tmp'],
    }), 'remote_sync upload');
    assert(synced.method === 'rsync' && synced.direction === 'upload', `sync result mismatch: ${JSON.stringify(synced)}`);
    const afterSync = assertToolSuccess(await call('remote_list', {
      target: HOST,
      path: remoteSyncDir,
    }), 'remote_list after sync');
    assert(
      afterSync.entries.map((entry) => entry.name).join(',') === 'keep.txt',
      `exclude list was not honored: ${JSON.stringify(afterSync)}`,
    );

    assertToolSuccess(await call('remote_write', {
      target: HOST,
      path: `${remoteSyncDir}/stale.txt`,
      text: 'stale\n',
    }), 'remote_write stale sync file');
    const deleteSync = assertToolSuccess(await call('remote_sync', {
      target: HOST,
      local_path: `${syncSourceDir}/`,
      remote_path: `${remoteSyncDir}/`,
      direction: 'upload',
      recursive: true,
      delete: true,
      exclude: ['*.tmp'],
    }), 'remote_sync delete');
    assert(deleteSync.delete === true, `sync delete metadata mismatch: ${JSON.stringify(deleteSync)}`);
    const afterDeleteSync = assertToolSuccess(await call('remote_list', {
      target: HOST,
      path: remoteSyncDir,
    }), 'remote_list after sync delete');
    assert(
      afterDeleteSync.entries.map((entry) => entry.name).join(',') === 'keep.txt',
      `sync delete did not remove stale path: ${JSON.stringify(afterDeleteSync)}`,
    );

    const deleted = assertToolSuccess(await call('remote_delete', {
      target: HOST,
      path: remoteRoot,
      recursive: true,
    }), 'remote_delete transfer root');
    assert(deleted.deleted === true && deleted.path === remoteRoot, `remote cleanup mismatch: ${JSON.stringify(deleted)}`);
    remoteRootCreated = false;

    process.stdout.write(
      `TRANSFER_ROUNDTRIP_OK bytes=${ROUNDTRIP_BYTES} resume_bytes=${RESUME_BYTES} resumed=true sync=true sha256=${sourceSha256}\n`,
    );
  } finally {
    if (remoteRootCreated) {
      await call('remote_delete', {
        target: HOST,
        path: remoteRoot,
        recursive: true,
      }).catch(() => {});
    }
    await client.close().catch(() => {});
    await fs.rm(localRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
