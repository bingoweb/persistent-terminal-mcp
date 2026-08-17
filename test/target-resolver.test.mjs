import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { resolveTarget } from '../src/target-resolver.mjs';

function fakeSpawn(stdoutText, { stderrText = '', code = 0, onSpawn } = {}) {
  return (command, args) => {
    onSpawn?.(command, args);

    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    queueMicrotask(() => {
      child.stdout.end(stdoutText);
      child.stderr.end(stderrText);
      child.emit('close', code, null);
    });

    return child;
  };
}

test('resolves alias using ssh -G while preserving alias for later commands', async () => {
  let invocation;
  const spawnImpl = fakeSpawn(
    [
      'host test-host',
      'hostname 203.0.113.10',
      'user tester',
      'port 22',
      'identityfile ~/.ssh/id_test_host',
      'proxyjump none',
      'stricthostkeychecking ask',
      'identityfile ~/.ssh/second_key',
      '',
    ].join('\n'),
    { onSpawn: (command, args) => { invocation = { command, args }; } },
  );

  const target = await resolveTarget('test-host', { spawnImpl });

  assert.deepEqual(invocation, { command: 'ssh', args: ['-G', 'test-host'] });
  assert.equal(target.alias, 'test-host');
  assert.equal(target.host, 'test-host');
  assert.equal(target.hostname, '203.0.113.10');
  assert.equal(target.user, 'tester');
  assert.equal(target.port, 22);
  assert.equal(target.identityFile, '~/.ssh/id_test_host');
  assert.equal(target.proxyJump, 'none');
  assert.equal(target.strictHostKeyChecking, 'ask');
});

test('rejects empty and NUL-containing aliases before spawning ssh', async () => {
  let calls = 0;
  const spawnImpl = () => { calls += 1; throw new Error('must not spawn'); };

  await assert.rejects(() => resolveTarget('', { spawnImpl }), /alias/i);
  await assert.rejects(() => resolveTarget('test-host\0evil', { spawnImpl }), /NUL/i);
  assert.equal(calls, 0);
});

test('classifies ssh -G failure as target resolution failure', async () => {
  const spawnImpl = fakeSpawn('', { stderrText: 'Could not resolve hostname', code: 255 });

  await assert.rejects(
    () => resolveTarget('missing-host', { spawnImpl }),
    (error) => error?.category === 'target_resolution_error' && /Could not resolve hostname/.test(error.message),
  );
});
