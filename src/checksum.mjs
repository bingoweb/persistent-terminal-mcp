import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';

const SHA256 = /^[0-9a-f]{64}$/u;
const REMOTE_SHA_COMMAND = 'sha256sum -- "$PERSISTENT_TERMINAL_SHA_PATH"';

function validateString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TerminalError('validation_error', `${field} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TerminalError('validation_error', `${field} must not contain NUL bytes`);
  }
}

export async function hashLocalFile(
  filePath,
  {
    createReadStreamImpl = createReadStream,
    createHashImpl = createHash,
  } = {},
) {
  validateString(filePath, 'local path');
  const hash = createHashImpl('sha256');

  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = createReadStreamImpl(filePath);
    } catch (error) {
      reject(new TerminalError(
        'local_capability_dependency_error',
        `unable to read local file for SHA-256: ${filePath}`,
        { cause: error, details: { path: filePath } },
      ));
      return;
    }

    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', (error) => reject(new TerminalError(
      'local_capability_dependency_error',
      `unable to read local file for SHA-256: ${filePath}`,
      { cause: error, details: { path: filePath, code: error?.code } },
    )));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export async function readRemoteSha256(
  target,
  remotePath,
  { remoteExecImpl = remoteExec } = {},
) {
  validateString(target, 'target');
  validateString(remotePath, 'remote path');

  const result = await remoteExecImpl({
    target,
    command: REMOTE_SHA_COMMAND,
    env: { PERSISTENT_TERMINAL_SHA_PATH: remotePath },
    timeout_ms: 60000,
    max_output_bytes: 4096,
  });

  if (result.timed_out) {
    throw new TerminalError(
      'timeout',
      'remote SHA-256 calculation timed out',
      { retryable: true, details: { target, remote_path: remotePath } },
    );
  }
  if (result.exit_code !== 0) {
    if (result.exit_code === 127 || /sha256sum:.*not found|sha256sum: command not found/iu.test(result.stderr ?? '')) {
      throw new TerminalError(
        'missing_remote_capability',
        'remote host does not provide sha256sum',
        { details: { capability: 'sha256sum', target } },
      );
    }
    throw new TerminalError(
      'remote_command_nonzero_exit',
      `remote sha256sum exited with status ${result.exit_code}`,
      {
        details: {
          target,
          remote_path: remotePath,
          exit_code: result.exit_code,
          stderr: result.stderr ?? '',
        },
      },
    );
  }
  if (result.truncated) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'remote SHA-256 output exceeded the bounded response size',
      { details: { target, remote_path: remotePath } },
    );
  }

  const digest = result.stdout?.trim().split(/\s+/u)[0]?.toLowerCase() ?? '';
  if (!SHA256.test(digest)) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'remote sha256sum returned malformed output',
      { details: { target, remote_path: remotePath } },
    );
  }
  return digest;
}

export async function verifyTransferSha256(
  { target, localPath, remotePath },
  {
    hashLocalFileImpl = hashLocalFile,
    readRemoteSha256Impl = readRemoteSha256,
  } = {},
) {
  validateString(target, 'target');
  validateString(localPath, 'local path');
  validateString(remotePath, 'remote path');

  const [localSha256, remoteSha256] = await Promise.all([
    hashLocalFileImpl(localPath),
    readRemoteSha256Impl(target, remotePath),
  ]);

  if (localSha256 !== remoteSha256) {
    throw new TerminalError(
      'checksum_integrity_failure',
      'local and remote SHA-256 digests do not match',
      {
        details: {
          local_path: localPath,
          remote_path: remotePath,
          local_sha256: localSha256,
          remote_sha256: remoteSha256,
        },
      },
    );
  }

  return { verified_sha256: true };
}
