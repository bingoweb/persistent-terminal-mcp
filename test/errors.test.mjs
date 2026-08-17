import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from '../src/errors.mjs';
import { commandResult } from '../src/results.mjs';

test('transport failure remains distinct from remote non-zero exit', () => {
  const err = new TerminalError('transport_reconnect_failure', 'ssh disconnected', {
    retryable: true,
  });

  assert.deepEqual(normalizeFailure(err), {
    category: 'transport_reconnect_failure',
    message: 'ssh disconnected',
    retryable: true,
  });

  assert.equal(
    commandResult({ exitCode: 7, stdout: '', stderr: 'bad', durationMs: 4 }).exit_code,
    7,
  );
});

test('error category vocabulary is closed', () => {
  assert(ERROR_CATEGORIES.has('validation_error'));
  assert(ERROR_CATEGORIES.has('checksum_integrity_failure'));
  assert.throws(
    () => new TerminalError('transport_failure', 'legacy category must not leak'),
    /unsupported error category/i,
  );
});

test('command result exposes only normalized snake_case public fields', () => {
  assert.deepEqual(
    commandResult({
      exitCode: 3,
      stdout: 'out',
      stderr: 'err',
      durationMs: 9,
      timedOut: true,
      truncated: true,
    }),
    {
      exit_code: 3,
      stdout: 'out',
      stderr: 'err',
      duration_ms: 9,
      timed_out: true,
      truncated: true,
    },
  );
});
