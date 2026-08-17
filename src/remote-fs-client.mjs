import { readFile } from 'node:fs/promises';

import { ERROR_CATEGORIES, TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';
import { quotePosix } from './ssh-runner.mjs';

const HELPER_URL = new URL('../helpers/remote_fs.py', import.meta.url);
const PYTHON_PROBE = 'command -v python3 >/dev/null 2>&1';
const PATH_FIELDS = Object.freeze(['path', 'source_path', 'destination_path']);
const PROBE_TIMEOUT_MS = 10_000;
const HELPER_TIMEOUT_MS = 60_000;
const PROBE_OUTPUT_BYTES = 4096;
const HELPER_OUTPUT_BYTES = 1024 * 1024;

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
  return readFile(HELPER_URL, 'utf8');
}

export async function callRemoteFs(
  target,
  request,
  {
    execImpl = remoteExec,
    helperSource,
    helperSourceLoader = defaultHelperSource,
  } = {},
) {
  validateTarget(target);
  validateRequest(request);

  const probe = await execImpl({
    target,
    command: PYTHON_PROBE,
    timeout_ms: PROBE_TIMEOUT_MS,
    max_output_bytes: PROBE_OUTPUT_BYTES,
  });
  assertCommandCompleted(probe, 'Remote python3 probe');
  if (probe.exit_code !== 0) {
    throw new TerminalError(
      'missing_remote_capability',
      'Remote target does not provide python3',
      { details: { exit_code: probe.exit_code } },
    );
  }

  const source = helperSource ?? await helperSourceLoader();
  if (typeof source !== 'string' || source.length === 0) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'Remote filesystem helper source is unavailable',
    );
  }

  const execution = await execImpl({
    target,
    command: `python3 -c ${quotePosix(source)}`,
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
