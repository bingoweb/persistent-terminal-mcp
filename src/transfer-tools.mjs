import fs from 'node:fs/promises';

import { verifyTransferSha256 } from './checksum.mjs';
import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import { callRemoteFs } from './remote-fs-client.mjs';
import { detectTransferCapabilities } from './transfer-capabilities.mjs';
import { createTransferResult } from './transfer-result.mjs';
import { runTransferProcess } from './transfer-runner.mjs';

const FAILURE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...ERROR_CATEGORIES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    details: {},
  },
  required: ['category', 'message', 'retryable'],
  additionalProperties: false,
});

const TARGET = Object.freeze({ type: 'string', minLength: 1, description: 'Native OpenSSH host or alias.' });
const PATH = Object.freeze({ type: 'string', minLength: 1 });
const BOOL = Object.freeze({ type: 'boolean', default: false });

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TRANSFER_RESULT_SCHEMA = objectSchema({
  method: { type: 'string', enum: ['scp', 'rsync'] },
  bytes_total: { type: 'number', minimum: 0 },
  bytes_transferred: { type: 'number', minimum: 0 },
  resumed: { type: 'boolean' },
  resume_supported: { type: 'boolean' },
  verified_sha256: { type: 'boolean' },
  duration_ms: { type: 'number', minimum: 0 },
}, [
  'method',
  'bytes_total',
  'bytes_transferred',
  'resumed',
  'resume_supported',
  'verified_sha256',
  'duration_ms',
]);

const SYNC_RESULT_SCHEMA = objectSchema({
  method: { type: 'string', enum: ['rsync'] },
  direction: { type: 'string', enum: ['upload', 'download'] },
  bytes_transferred: { type: 'number', minimum: 0 },
  files_transferred: { type: 'number', minimum: 0 },
  dry_run: { type: 'boolean' },
  delete: { type: 'boolean' },
  duration_ms: { type: 'number', minimum: 0 },
}, [
  'method',
  'direction',
  'bytes_transferred',
  'files_transferred',
  'dry_run',
  'delete',
  'duration_ms',
]);

function outputSchema(success) {
  return { type: 'object', oneOf: [success, FAILURE_SCHEMA] };
}

function transferTool(name, description) {
  return Object.freeze({
    name,
    description,
    inputSchema: objectSchema({
      target: TARGET,
      local_path: PATH,
      remote_path: PATH,
      recursive: BOOL,
      preserve: BOOL,
      resume: BOOL,
      verify_sha256: BOOL,
    }, ['target', 'local_path', 'remote_path']),
    outputSchema: outputSchema(TRANSFER_RESULT_SCHEMA),
  });
}

export const TRANSFER_TOOLS = Object.freeze([
  transferTool('remote_upload', 'Upload a local path to a remote OpenSSH target without placing file bytes in MCP payloads.'),
  transferTool('remote_download', 'Download a remote path to a local filesystem path without placing file bytes in MCP payloads.'),
  Object.freeze({
    name: 'remote_sync',
    description: 'Synchronize local and remote paths with explicit rsync semantics and no scp fallback.',
    inputSchema: objectSchema({
      target: TARGET,
      local_path: PATH,
      remote_path: PATH,
      direction: { type: 'string', enum: ['upload', 'download'] },
      recursive: BOOL,
      delete: BOOL,
      dry_run: BOOL,
      exclude: { type: 'array', items: { type: 'string' }, maxItems: 100, default: [] },
    }, ['target', 'local_path', 'remote_path', 'direction']),
    outputSchema: outputSchema(SYNC_RESULT_SCHEMA),
  }),
]);

export const TRANSFER_TOOL_NAMES = new Set(TRANSFER_TOOLS.map((tool) => tool.name));

function result(value, { isError = false } = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) response.isError = true;
  return response;
}

function validateString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TerminalError('validation_error', `${field} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TerminalError('validation_error', `${field} must not contain NUL bytes`);
  }
}

function validateArgs(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TerminalError('validation_error', `${name} arguments must be an object`);
  }
  validateString(args.target, 'target');
  if (args.target.includes(':')) {
    throw new TerminalError('validation_error', 'transfer target must be an OpenSSH alias without a colon');
  }
  validateString(args.local_path, 'local_path');
  validateString(args.remote_path, 'remote_path');
  for (const field of ['recursive', 'preserve', 'resume', 'verify_sha256']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') {
      throw new TerminalError('validation_error', `${field} must be a boolean`);
    }
  }
  if (name === 'remote_sync') {
    if (!['upload', 'download'].includes(args.direction)) {
      throw new TerminalError('validation_error', 'direction must be upload or download');
    }
    for (const field of ['delete', 'dry_run']) {
      if (args[field] !== undefined && typeof args[field] !== 'boolean') {
        throw new TerminalError('validation_error', `${field} must be a boolean`);
      }
    }
    if (args.exclude !== undefined) {
      if (!Array.isArray(args.exclude) || args.exclude.length > 100) {
        throw new TerminalError('validation_error', 'exclude must be an array with at most 100 entries');
      }
      for (const pattern of args.exclude) validateString(pattern, 'exclude entry');
    }
  }
}

function remoteOperand(target, remotePath) {
  return `${target}:${remotePath}`;
}

function selectMethod(capabilities, { resume }) {
  if (resume) {
    if (!capabilities.local.rsync.available) {
      throw new TerminalError(
        'local_capability_dependency_error',
        'resume requires local rsync',
        { details: { capability: 'rsync' } },
      );
    }
    if (!capabilities.remote.rsync.available) {
      throw new TerminalError(
        'missing_remote_capability',
        'resume requires remote rsync',
        { details: { capability: 'rsync' } },
      );
    }
    return { method: 'rsync', executable: capabilities.local.rsync.path };
  }
  if (capabilities.local.scp.available) {
    return { method: 'scp', executable: capabilities.local.scp.path };
  }
  if (capabilities.local.rsync.available && capabilities.remote.rsync.available) {
    return { method: 'rsync', executable: capabilities.local.rsync.path };
  }
  throw new TerminalError(
    'local_capability_dependency_error',
    'neither scp nor usable rsync is available for transfer',
    { details: { capabilities } },
  );
}

function scpArgs(name, args) {
  const values = [];
  if (args.recursive) values.push('-r');
  if (args.preserve) values.push('-p');
  values.push('--');
  const remote = remoteOperand(args.target, args.remote_path);
  if (name === 'remote_upload') values.push(args.local_path, remote);
  else values.push(remote, args.local_path);
  return values;
}

function rsyncArgs(name, args) {
  const values = ['--secluded-args'];
  if (args.resume) values.push('--partial', '--info=progress2');
  else values.push('--info=progress2');
  if (args.recursive) values.push('--recursive');
  if (args.preserve) values.push('--perms', '--times');
  values.push('--');
  const remote = remoteOperand(args.target, args.remote_path);
  if (name === 'remote_upload') values.push(args.local_path, remote);
  else values.push(remote, args.local_path);
  return values;
}

function syncArgs(args) {
  const values = ['--secluded-args', '--info=progress2', '--stats'];
  if (args.recursive) values.push('--recursive');
  if (args.delete) values.push('--delete');
  if (args.dry_run) values.push('--dry-run');
  for (const pattern of args.exclude) values.push(`--exclude=${pattern}`);
  values.push('--');
  const remote = remoteOperand(args.target, args.remote_path);
  if (args.direction === 'upload') values.push(args.local_path, remote);
  else values.push(remote, args.local_path);
  return values;
}

function requireSyncRsync(capabilities) {
  if (!capabilities.local.rsync.available) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'remote_sync requires local rsync',
      { details: { capability: 'rsync' } },
    );
  }
  if (!capabilities.remote.rsync.available) {
    throw new TerminalError(
      'missing_remote_capability',
      'remote_sync requires remote rsync',
      { details: { capability: 'rsync' } },
    );
  }
  return capabilities.local.rsync.path;
}

async function callRemoteSync(
  args,
  { detectTransferCapabilitiesImpl, runTransferProcessImpl },
) {
  const request = {
    ...args,
    recursive: args.recursive ?? false,
    delete: args.delete ?? false,
    dry_run: args.dry_run ?? false,
    exclude: args.exclude ?? [],
  };
  const capabilities = await detectTransferCapabilitiesImpl(args.target);
  const executable = requireSyncRsync(capabilities);
  const execution = await runTransferProcessImpl(executable, syncArgs(request));
  return {
    method: 'rsync',
    direction: request.direction,
    bytes_transferred: execution.bytesTransferred ?? 0,
    files_transferred: execution.filesTransferred ?? 0,
    dry_run: request.dry_run,
    delete: request.delete,
    duration_ms: execution.durationMs ?? 0,
  };
}

async function localStat(pathValue, statLocalPathImpl) {
  try {
    return await statLocalPathImpl(pathValue);
  } catch (error) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `local transfer path is not accessible: ${pathValue}`,
      { cause: error, details: { path: pathValue, code: error?.code } },
    );
  }
}

async function observeRemotePartialFile(
  target,
  remotePath,
  localSize,
  statRemotePathImpl,
) {
  try {
    const metadata = await statRemotePathImpl(target, remotePath);
    return metadata?.type === 'file'
      && Number.isFinite(metadata.size)
      && metadata.size > 0
      && metadata.size < localSize;
  } catch {
    // Resume evidence is observational only. A target that lacks the
    // structured filesystem helper must still be able to use rsync.
    return false;
  }
}

export async function callTransferTool(
  name,
  args = {},
  {
    detectTransferCapabilitiesImpl = detectTransferCapabilities,
    runTransferProcessImpl = runTransferProcess,
    statLocalPathImpl = fs.stat,
    statRemotePathImpl = (target, path) => callRemoteFs(target, { op: 'stat', path }),
    verifyTransferSha256Impl = verifyTransferSha256,
  } = {},
) {
  try {
    if (!TRANSFER_TOOL_NAMES.has(name)) {
      throw new TerminalError('validation_error', `Unknown transfer tool: ${name}`);
    }
    validateArgs(name, args);

    if (name === 'remote_sync') {
      return result(await callRemoteSync(args, {
        detectTransferCapabilitiesImpl,
        runTransferProcessImpl,
      }));
    }

    const options = {
      recursive: args.recursive ?? false,
      preserve: args.preserve ?? false,
      resume: args.resume ?? false,
      verify_sha256: args.verify_sha256 ?? false,
    };

    const request = { ...args, ...options };
    let uploadStat = null;
    if (name === 'remote_upload') {
      uploadStat = await localStat(args.local_path, statLocalPathImpl);
      if (uploadStat.isDirectory() && !options.recursive) {
        throw new TerminalError(
          'validation_error',
          'uploading a directory requires recursive=true',
          { details: { path: args.local_path } },
        );
      }
      if (uploadStat.isDirectory() && options.verify_sha256) {
        throw new TerminalError(
          'validation_error',
          'verify_sha256 currently supports regular-file transfers only',
          { details: { path: args.local_path } },
        );
      }
    }

    const capabilities = await detectTransferCapabilitiesImpl(args.target);
    const selected = selectMethod(capabilities, options);
    const observedResume = name === 'remote_upload'
      && options.resume
      && selected.method === 'rsync'
      && uploadStat
      && !uploadStat.isDirectory()
      ? await observeRemotePartialFile(
        args.target,
        args.remote_path,
        uploadStat.size,
        statRemotePathImpl,
      )
      : false;
    const argv = selected.method === 'scp' ? scpArgs(name, request) : rsyncArgs(name, request);
    const execution = await runTransferProcessImpl(selected.executable, argv);

    let bytesTotal = execution.bytesTotal ?? 0;
    let bytesTransferred = execution.bytesTransferred ?? 0;
    if (name === 'remote_upload' && uploadStat && !uploadStat.isDirectory()) {
      bytesTotal = uploadStat.size;
      if (selected.method === 'scp' || bytesTransferred === 0) bytesTransferred = uploadStat.size;
    }
    if (name === 'remote_download') {
      const downloaded = await localStat(args.local_path, statLocalPathImpl);
      if (downloaded.isDirectory() && options.verify_sha256) {
        throw new TerminalError(
          'validation_error',
          'verify_sha256 currently supports regular-file transfers only',
          { details: { path: args.local_path } },
        );
      }
      if (!downloaded.isDirectory()) {
        bytesTotal = downloaded.size;
        if (selected.method === 'scp' || bytesTransferred === 0) bytesTransferred = downloaded.size;
      }
    }

    const verification = options.verify_sha256
      ? await verifyTransferSha256Impl({
        target: args.target,
        localPath: args.local_path,
        remotePath: args.remote_path,
      })
      : { verified_sha256: false };

    return result(createTransferResult({
      method: selected.method,
      bytesTotal,
      bytesTransferred,
      resumed: selected.method === 'rsync'
        ? observedResume || Boolean(execution.resumed)
        : false,
      resumeSupported: selected.method === 'rsync',
      verifiedSha256: verification.verified_sha256 === true,
      durationMs: execution.durationMs ?? 0,
    }));
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}
