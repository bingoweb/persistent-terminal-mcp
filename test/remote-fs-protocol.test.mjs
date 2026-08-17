import test from 'node:test';
import assert from 'node:assert/strict';

import { TerminalError } from '../src/errors.mjs';
import { callRemoteFs } from '../src/remote-fs-client.mjs';

function commandResult(overrides = {}) {
  return {
    exit_code: 0,
    stdout: '',
    stderr: '',
    duration_ms: 1,
    timed_out: false,
    truncated: false,
    ...overrides,
  };
}

function errorCategory(category) {
  return (error) => error instanceof TerminalError && error.category === category;
}

test('NUL in a remote path is rejected before any SSH execution', async () => {
  let calls = 0;
  const execImpl = async () => {
    calls += 1;
    throw new Error('must not execute');
  };

  await assert.rejects(
    () => callRemoteFs(
      'test-host',
      { op: 'stat', path: '/tmp/bad\0path' },
      { execImpl, helperSource: 'pass' },
    ),
    errorCategory('validation_error'),
  );
  assert.equal(calls, 0);
});

test('missing remote python3 is a capability error and helper execution is skipped', async () => {
  const calls = [];
  const execImpl = async (request) => {
    calls.push(request);
    return commandResult({ exit_code: 1 });
  };

  await assert.rejects(
    () => callRemoteFs('test-host', { op: 'protocol_ping' }, { execImpl, helperSource: 'pass' }),
    errorCategory('missing_remote_capability'),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'command -v python3 >/dev/null 2>&1');
});

test('malformed helper JSON is normalized as a helper protocol dependency failure', async () => {
  let calls = 0;
  const execImpl = async () => {
    calls += 1;
    if (calls === 1) return commandResult();
    return commandResult({ stdout: 'not-json\n' });
  };

  await assert.rejects(
    () => callRemoteFs('test-host', { op: 'protocol_ping' }, { execImpl, helperSource: 'pass' }),
    (error) => (
      error instanceof TerminalError
      && error.category === 'local_capability_dependency_error'
      && /malformed JSON/i.test(error.message)
    ),
  );
});

test('helper operation errors preserve the closed error category, message, and details', async () => {
  let calls = 0;
  const execImpl = async () => {
    calls += 1;
    if (calls === 1) return commandResult();
    return commandResult({
      stdout: JSON.stringify({
        ok: false,
        error: {
          category: 'permission_privilege_error',
          message: 'permission denied',
          details: { path: '/root/private' },
        },
      }),
    });
  };

  await assert.rejects(
    () => callRemoteFs('test-host', { op: 'stat', path: '/root/private' }, { execImpl, helperSource: 'pass' }),
    (error) => (
      error instanceof TerminalError
      && error.category === 'permission_privilege_error'
      && error.message === 'permission denied'
      && error.details?.path === '/root/private'
    ),
  );
});

test('request data stays in JSON stdin and is never interpolated into the remote command', async () => {
  const calls = [];
  const path = "/tmp/user data/'quoted'/file.txt";
  const helperSource = 'import sys\nprint(sys.stdin.read())';
  const execImpl = async (request) => {
    calls.push(request);
    if (calls.length === 1) return commandResult();
    return commandResult({ stdout: JSON.stringify({ ok: true, result: { protocol: 1 } }) });
  };

  const result = await callRemoteFs(
    'test-host',
    { op: 'protocol_ping', path },
    { execImpl, helperSource },
  );

  assert.deepEqual(result, { protocol: 1 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].command, /^python3 -c /);
  assert.equal(calls[1].command.includes(path), false);
  assert.equal(calls[1].stdin, JSON.stringify({ op: 'protocol_ping', path }));
});

test('transport failures from the existing remote execution layer are not reclassified', async () => {
  const failure = new TerminalError(
    'transport_reconnect_failure',
    'connection reset',
    { retryable: true },
  );
  const execImpl = async () => {
    throw failure;
  };

  await assert.rejects(
    () => callRemoteFs('test-host', { op: 'protocol_ping' }, { execImpl, helperSource: 'pass' }),
    (error) => error === failure,
  );
});
