import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { remoteExec } from '../src/remote-exec.mjs';
import { runSshCommand } from '../src/ssh-runner.mjs';

function fakeRunner(result) {
  return async () => ({
    code: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
    ...result,
  });
}

function fakeChild({ stdout = '', stderr = '', code = 0, closeOnSpawn = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdinText = '';
  child.killedWith = null;
  child.stdin.on('data', (chunk) => { child.stdinText += chunk.toString(); });
  child.kill = (signal) => {
    child.killedWith = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };

  if (closeOnSpawn) {
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', code, null);
    });
  }
  return child;
}

test('remote_exec returns non-zero process status as a valid command result', async () => {
  const out = await remoteExec(
    { target: 'taylan', command: 'exit 7' },
    { runner: fakeRunner({ code: 7, stderr: 'bad' }) },
  );

  assert.deepEqual(out, {
    exit_code: 7,
    stdout: '',
    stderr: 'bad',
    duration_ms: 1,
    timed_out: false,
    truncated: false,
  });
});

test('ssh exit 255 becomes a transport/reconnect failure', async () => {
  await assert.rejects(
    () => remoteExec(
      { target: 'taylan', command: 'true' },
      { runner: fakeRunner({ code: 255, stderr: 'connection reset' }) },
    ),
    (error) => error?.category === 'transport_reconnect_failure' && /connection reset/i.test(error.message),
  );
});

test('ssh host-key or authentication failures keep their own category', async () => {
  await assert.rejects(
    () => remoteExec(
      { target: 'taylan', command: 'true' },
      { runner: fakeRunner({ code: 255, stderr: 'Host key verification failed.' }) },
    ),
    (error) => error?.category === 'host_key_authentication_error',
  );
});

test('runner preserves ssh alias and safely carries cwd env and stdin', async () => {
  let invocation;
  let child;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    child = fakeChild({ stdout: 'ok' });
    return child;
  };
  const resolveTargetImpl = async (alias) => ({ alias });

  const result = await runSshCommand(
    'taylan',
    {
      command: "printf '%s' \"$FOO\"",
      cwd: "/tmp/dir with 'quote",
      env: { FOO: "bar baz 'quoted'" },
      stdin: 'payload\n',
      timeout_ms: 1000,
      max_output_bytes: 1024,
    },
    { spawnImpl, resolveTargetImpl },
  );

  assert.equal(invocation.command, 'ssh');
  assert.deepEqual(invocation.args.slice(0, 5), [
    '-T', '-o', 'BatchMode=yes', 'taylan', '--',
  ]);
  assert.equal(invocation.args.length, 6);
  assert.match(invocation.args[5], /^\/bin\/sh -lc '/);
  assert.match(invocation.args[5], /cd /);
  assert.match(invocation.args[5], /env FOO=/);
  assert.equal(child.stdinText, 'payload\n');
  assert.equal(result.stdout, 'ok');
});

test('runner caps collected output while continuing to drain streams', async () => {
  const result = await runSshCommand(
    'taylan',
    { command: 'big-output', max_output_bytes: 8 },
    {
      spawnImpl: () => fakeChild({ stdout: 'abcdefghij', stderr: 'KLMNOPQRST' }),
      resolveTargetImpl: async (alias) => ({ alias }),
    },
  );

  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 8);
  assert.equal(result.truncated, true);
});

test('runner terminates a command on timeout and reports timed_out', async () => {
  const child = fakeChild({ closeOnSpawn: false });
  const result = await runSshCommand(
    'taylan',
    { command: 'sleep 60', timeout_ms: 5 },
    {
      spawnImpl: () => child,
      resolveTargetImpl: async (alias) => ({ alias }),
    },
  );

  assert.equal(child.killedWith, 'SIGTERM');
  assert.equal(result.timedOut, true);
});

test('remote_exec validates target and command before invoking runner', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return {}; };

  await assert.rejects(() => remoteExec({ target: '', command: 'true' }, { runner }), /target/i);
  await assert.rejects(() => remoteExec({ target: 'taylan', command: '' }, { runner }), /command/i);
  assert.equal(calls, 0);
});
