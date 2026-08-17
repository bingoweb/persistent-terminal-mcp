import { spawn } from 'node:child_process';

import { TerminalError } from './errors.mjs';
import { resolveTarget } from './target-resolver.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quotePosix(value) {
  if (typeof value !== 'string') {
    throw new TerminalError('validation_error', 'Shell value must be a string');
  }
  if (value.includes('\0')) {
    throw new TerminalError('validation_error', 'Shell value must not contain NUL bytes');
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validatePositiveInteger(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TerminalError('validation_error', `${field} must be a positive integer`);
  }
  return value;
}

function buildRemoteScript(request) {
  const { command, cwd, env = {} } = request;

  if (typeof command !== 'string' || command.trim() === '') {
    throw new TerminalError('validation_error', 'command must be a non-empty string');
  }
  if (command.includes('\0')) {
    throw new TerminalError('validation_error', 'command must not contain NUL bytes');
  }

  if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) {
    throw new TerminalError('validation_error', 'cwd must be a non-empty string when provided');
  }

  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TerminalError('validation_error', 'env must be an object of string values');
  }

  const assignments = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) {
      throw new TerminalError('validation_error', `Invalid environment variable name: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new TerminalError('validation_error', `Environment variable ${key} must be a string`);
    }
    assignments.push(`${key}=${quotePosix(value)}`);
  }

  const commandShell = `/bin/sh -lc ${quotePosix(command)}`;
  const withEnv = assignments.length > 0
    ? `env ${assignments.join(' ')} ${commandShell}`
    : commandShell;

  return cwd === undefined
    ? withEnv
    : `cd ${quotePosix(cwd)} && ${withEnv}`;
}

function collectBounded(shared, chunk, bucket) {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = Math.max(0, shared.limit - shared.collected);
  const accepted = data.subarray(0, remaining);

  if (accepted.length > 0) bucket.push(accepted);
  shared.collected += accepted.length;
  if (accepted.length < data.length) shared.truncated = true;
}

export async function runSshCommand(
  targetAlias,
  request,
  {
    spawnImpl = spawn,
    resolveTargetImpl = resolveTarget,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  if (typeof targetAlias !== 'string' || targetAlias.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty string');
  }

  const timeoutMs = validatePositiveInteger(request.timeout_ms, 'timeout_ms', DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = validatePositiveInteger(
    request.max_output_bytes,
    'max_output_bytes',
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  if (
    request.stdin !== undefined
    && typeof request.stdin !== 'string'
    && !Buffer.isBuffer(request.stdin)
  ) {
    throw new TerminalError('validation_error', 'stdin must be a string or Buffer');
  }
  const remoteScript = buildRemoteScript(request);
  const remoteCommand = `/bin/sh -lc ${quotePosix(remoteScript)}`;
  const target = await resolveTargetImpl(targetAlias);
  const startedAt = now();

  let child;
  try {
    child = spawnImpl(
      'ssh',
      ['-T', '-o', 'BatchMode=yes', target.alias, '--', remoteCommand],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (error) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `Unable to start OpenSSH: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const shared = { limit: maxOutputBytes, collected: 0, truncated: false };
  const stdoutChunks = [];
  const stderrChunks = [];
  let timedOut = false;

  child.stdout?.on('data', (chunk) => collectBounded(shared, chunk, stdoutChunks));
  child.stderr?.on('data', (chunk) => collectBounded(shared, chunk, stderrChunks));

  const completed = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new TerminalError(
      'local_capability_dependency_error',
      `OpenSSH execution failed to start: ${error.message}`,
      { cause: error },
    )));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const timer = setTimeoutImpl(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);

  if (request.stdin !== undefined) {
    child.stdin.end(request.stdin);
  } else {
    child.stdin.end();
  }

  let closeResult;
  try {
    closeResult = await completed;
  } finally {
    clearTimeoutImpl(timer);
  }

  return {
    code: closeResult.code,
    signal: closeResult.signal,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    durationMs: Math.max(0, now() - startedAt),
    timedOut,
    truncated: shared.truncated,
  };
}
