import { TerminalError } from './errors.mjs';
import { commandResult } from './results.mjs';
import { runSshCommand } from './ssh-runner.mjs';

function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TerminalError('validation_error', 'remote_exec request must be an object');
  }
  if (typeof request.target !== 'string' || request.target.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty string');
  }
  if (request.target.includes('\0')) {
    throw new TerminalError('validation_error', 'target must not contain NUL bytes');
  }
  if (typeof request.command !== 'string' || request.command.trim() === '') {
    throw new TerminalError('validation_error', 'command must be a non-empty string');
  }
}

function isAuthenticationFailure(stderr) {
  return /host key verification failed|permission denied|authentication failed|no supported authentication methods/i
    .test(stderr ?? '');
}

export async function remoteExec(request, { runner = runSshCommand } = {}) {
  validateRequest(request);

  const raw = await runner(request.target, request);

  if (raw.code === 255 && !raw.timedOut) {
    if (isAuthenticationFailure(raw.stderr)) {
      throw new TerminalError(
        'host_key_authentication_error',
        raw.stderr || 'OpenSSH host-key/authentication failure',
        { retryable: false },
      );
    }

    throw new TerminalError(
      'transport_reconnect_failure',
      raw.stderr || 'OpenSSH transport failed',
      { retryable: true },
    );
  }

  return commandResult({
    exitCode: raw.code,
    stdout: raw.stdout,
    stderr: raw.stderr,
    durationMs: raw.durationMs,
    timedOut: raw.timedOut,
    truncated: raw.truncated,
  });
}
