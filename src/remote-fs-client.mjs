import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { ERROR_CATEGORIES, TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';

const HELPER_URL = new URL('../helpers/remote_fs.py', import.meta.url);
const PATH_FIELDS = Object.freeze(['path', 'source_path', 'destination_path']);
const INSTALL_TIMEOUT_MS = 15_000;
const HELPER_TIMEOUT_MS = 60_000;
const INSTALL_OUTPUT_BYTES = 4096;
const HELPER_OUTPUT_BYTES = 1024 * 1024;
let helperSourcePromise = null;

export function createRemoteFsCache() {
  return {
    ready: new Set(),
    pending: new Map(),
  };
}

const defaultCache = createRemoteFsCache();

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty string');
  }
  if (target.includes('\0')) {
    throw new TerminalError('validation_error', 'target must not contain NUL bytes');
  }
}

function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TerminalError('validation_error', 'remote filesystem request must be an object');
  }
  if (typeof request.op !== 'string' || request.op.trim() === '') {
    throw new TerminalError('validation_error', 'op must be a non-empty string');
  }

  for (const field of PATH_FIELDS) {
    if (request[field] === undefined) continue;
    if (typeof request[field] !== 'string' || request[field] === '') {
      throw new TerminalError('validation_error', `${field} must be a non-empty string`);
    }
    if (request[field].includes('\0')) {
      throw new TerminalError('validation_error', `${field} must not contain NUL bytes`);
    }
  }
}

function assertCommandCompleted(result, label) {
  if (result?.timed_out === true) {
    throw new TerminalError('timeout', `${label} timed out`, { retryable: true });
  }
  if (result?.truncated === true) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `${label} output exceeded the protocol limit`,
    );
  }
}

function parseEnvelope(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'Remote filesystem helper returned malformed JSON',
      { cause: error },
    );
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'Remote filesystem helper returned an invalid response envelope',
    );
  }

  if (payload.ok === true && Object.hasOwn(payload, 'result')) {
    return payload.result;
  }

  if (payload.ok !== false || payload.error === null || typeof payload.error !== 'object') {
    throw new TerminalError(
      'local_capability_dependency_error',
      'Remote filesystem helper returned an invalid response envelope',
    );
  }

  const { category, message, details } = payload.error;
  if (!ERROR_CATEGORIES.has(category) || typeof message !== 'string' || message.length === 0) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'Remote filesystem helper returned an invalid error envelope',
      { details: { remote_error: payload.error } },
    );
  }

  throw new TerminalError(category, message, { details });
}

async function defaultHelperSource() {
  helperSourcePromise ??= readFile(HELPER_URL, 'utf8');
  return helperSourcePromise;
}

function helperHash(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function helperCommand(hash) {
  return `python3 "\${XDG_CACHE_HOME:-$HOME/.cache}/persistent-terminal-mcp/remote_fs_${hash}.py"`;
}

function installerCommand(hash) {
  return [
    'command -v python3 >/dev/null 2>&1 || exit 127',
    'umask 077',
    'PTEXT_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/persistent-terminal-mcp"',
    `PTEXT_HELPER="$PTEXT_CACHE_DIR/remote_fs_${hash}.py"`,
    'mkdir -p "$PTEXT_CACHE_DIR"',
    'PTEXT_TMP="$PTEXT_HELPER.$$"',
    'cat > "$PTEXT_TMP"',
    'chmod 700 "$PTEXT_TMP"',
    'mv -f "$PTEXT_TMP" "$PTEXT_HELPER"',
  ].join('; ');
}

async function ensureHelper(target, source, hash, execImpl, cache) {
  const key = `${target}\n${hash}`;
  if (cache.ready.has(key)) return;
  if (cache.pending.has(key)) return cache.pending.get(key);

  const pending = (async () => {
    const installed = await execImpl({
      target,
      command: installerCommand(hash),
      stdin: source,
      timeout_ms: INSTALL_TIMEOUT_MS,
      max_output_bytes: INSTALL_OUTPUT_BYTES,
    });
    assertCommandCompleted(installed, 'Remote filesystem helper install');
    if (installed.exit_code === 127) {
      throw new TerminalError(
        'missing_remote_capability',
        'Remote target does not provide python3',
        { details: { exit_code: installed.exit_code } },
      );
    }
    if (installed.exit_code !== 0) {
      throw new TerminalError(
        'remote_command_nonzero_exit',
        installed.stderr || `Remote filesystem helper install exited with status ${installed.exit_code}`,
        { details: { exit_code: installed.exit_code } },
      );
    }
    cache.ready.add(key);
  })();

  cache.pending.set(key, pending);
  try {
    await pending;
  } finally {
    cache.pending.delete(key);
  }
}

export async function callRemoteFs(
  target,
  request,
  {
    execImpl = remoteExec,
    helperSource,
    helperSourceLoader = defaultHelperSource,
    cache = defaultCache,
  } = {},
) {
  validateTarget(target);
  validateRequest(request);

  const source = helperSource ?? await helperSourceLoader();
  if (typeof source !== 'string' || source.length === 0) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'Remote filesystem helper source is unavailable',
    );
  }
  if (!cache || !(cache.ready instanceof Set) || !(cache.pending instanceof Map)) {
    throw new TerminalError('validation_error', 'remote filesystem cache is invalid');
  }
  const hash = helperHash(source);
  await ensureHelper(target, source, hash, execImpl, cache);

  const execution = await execImpl({
    target,
    command: helperCommand(hash),
    stdin: JSON.stringify(request),
    timeout_ms: HELPER_TIMEOUT_MS,
    max_output_bytes: HELPER_OUTPUT_BYTES,
  });
  assertCommandCompleted(execution, 'Remote filesystem helper');

  if (execution.exit_code !== 0) {
    throw new TerminalError(
      'remote_command_nonzero_exit',
      execution.stderr || `Remote filesystem helper exited with status ${execution.exit_code}`,
      { details: { exit_code: execution.exit_code } },
    );
  }

  return parseEnvelope(execution.stdout);
}
