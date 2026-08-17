import fs from 'node:fs/promises';
import path from 'node:path';

import { TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';

function validateExecutableName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TerminalError('validation_error', 'executable name must be a non-empty string');
  }
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw new TerminalError('validation_error', 'executable name must be a bare command name');
  }
}

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty string');
  }
  if (target.includes('\0')) {
    throw new TerminalError('validation_error', 'target must not contain NUL bytes');
  }
}

export async function findLocalExecutable(
  name,
  {
    pathEnv = process.env.PATH ?? '',
    accessImpl = fs.access,
    statImpl = fs.stat,
  } = {},
) {
  validateExecutableName(name);
  if (typeof pathEnv !== 'string') {
    throw new TerminalError('validation_error', 'PATH must be a string');
  }

  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await accessImpl(candidate, fs.constants.X_OK);
      const info = await statImpl(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // A PATH lookup skips missing, inaccessible, and non-executable entries.
    }
  }
  return null;
}

function capability(pathValue) {
  return {
    available: typeof pathValue === 'string' && pathValue.length > 0,
    path: typeof pathValue === 'string' && pathValue.length > 0 ? pathValue : null,
  };
}

export async function detectTransferCapabilities(
  target,
  {
    findLocalExecutableImpl = findLocalExecutable,
    remoteExecImpl = remoteExec,
  } = {},
) {
  validateTarget(target);

  const [localRsync, localScp] = await Promise.all([
    findLocalExecutableImpl('rsync'),
    findLocalExecutableImpl('scp'),
  ]);

  const remoteProbe = await remoteExecImpl({
    target,
    command: 'command -v rsync',
    timeout_ms: 5000,
    max_output_bytes: 1024,
  });
  if (remoteProbe.timed_out) {
    throw new TerminalError(
      'timeout',
      'remote rsync capability probe timed out',
      { retryable: true, details: { target } },
    );
  }

  const remotePath = remoteProbe.exit_code === 0
    ? remoteProbe.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null
    : null;

  return {
    local: {
      rsync: capability(localRsync),
      scp: capability(localScp),
    },
    remote: {
      rsync: capability(remotePath),
    },
  };
}
