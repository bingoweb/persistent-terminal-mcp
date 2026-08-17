import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSshMultiplexManager } from '../src/ssh-multiplex-manager.mjs';
import { createTelemetry } from '../src/telemetry.mjs';

async function tempHome(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptext-mux-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function resolved(alias = 'test-host') {
  return {
    alias,
    hostname: '203.0.113.20',
    user: 'tester',
    port: 22,
    proxyJump: 'none',
  };
}

function callbackExec(handler) {
  return (executable, args, options, callback) => {
    Promise.resolve()
      .then(() => handler(executable, args, options))
      .then(
        (result = {}) => callback(null, result.stdout ?? '', result.stderr ?? ''),
        (error) => callback(error, error?.stdout ?? '', error?.stderr ?? ''),
      );
  };
}

function execFailure(message = 'not running', code = 255) {
  const error = new Error(message);
  error.code = code;
  error.stderr = `${message}\n`;
  return error;
}

function controlPathFromCreateArgs(args) {
  const option = args.find((value) => value.startsWith('ControlPath='));
  return option?.slice('ControlPath='.length) ?? null;
}

test('multiplex off mode performs no filesystem or ssh control work', async () => {
  let resolveCalls = 0;
  let execCalls = 0;
  const manager = createSshMultiplexManager({
    env: { PTEXT_SSH_MULTIPLEX: 'off' },
    resolveTargetImpl: async () => { resolveCalls += 1; return resolved(); },
    execFileImpl: callbackExec(async () => { execCalls += 1; }),
  });

  assert.deepEqual(await manager.acquire('test-host'), { args: [], state: 'off' });
  assert.equal(resolveCalls, 0);
  assert.equal(execCalls, 0);
  assert.deepEqual(manager.snapshot(), {
    mode: 'off',
    active_masters: 0,
    max_targets: 32,
    control_persist_seconds: 300,
    masters: [],
  });
});

test('first acquire creates a master in a private hashed control path and second acquire is a hit', async (t) => {
  const homeDir = await tempHome(t);
  const calls = [];
  let masterAlive = false;
  let createdControlPath = null;
  const telemetry = createTelemetry();
  const execFileImpl = callbackExec(async (executable, args, options) => {
    calls.push({ executable, args: [...args], options: { ...options } });
    if (args.includes('-O') && args.includes('check')) {
      if (!masterAlive) throw execFailure();
      return { stdout: 'Master running (pid=1234)\n' };
    }
    if (args.includes('-MNf')) {
      createdControlPath = controlPathFromCreateArgs(args);
      assert.ok(createdControlPath);
      await fs.writeFile(createdControlPath, 'owned-test-socket');
      masterAlive = true;
      return {};
    }
    throw new Error(`unexpected ssh args: ${JSON.stringify(args)}`);
  });

  const manager = createSshMultiplexManager({
    env: {},
    homeDir,
    resolveTargetImpl: async () => resolved(),
    execFileImpl,
    telemetry,
  });

  const first = await manager.acquire('test-host');
  assert.equal(first.state, 'miss');
  assert.deepEqual(first.args.slice(0, 3), ['-o', 'ControlMaster=no', '-o']);
  assert.match(first.args[3], /^ControlPath=/u);
  assert.equal(first.args[3].slice('ControlPath='.length), createdControlPath);
  assert.match(path.basename(createdControlPath), /^ctl_[0-9a-f]{32}$/u);
  assert.equal(path.basename(createdControlPath).includes('test-host'), false);
  assert.equal(path.basename(createdControlPath).includes('tester'), false);

  const controlDir = path.dirname(createdControlPath);
  const mode = (await fs.stat(controlDir)).mode & 0o777;
  assert.equal(mode, 0o700);

  const second = await manager.acquire('test-host');
  assert.equal(second.state, 'hit');
  assert.deepEqual(second.args, first.args);
  assert.equal(calls.filter((call) => call.args.includes('-MNf')).length, 1);

  const createCall = calls.find((call) => call.args.includes('-MNf'));
  assert.ok(createCall.args.includes('ControlMaster=yes'));
  assert.ok(createCall.args.includes('ControlPersist=300'));
  assert.ok(createCall.args.includes('BatchMode=yes'));
  assert.equal(createCall.args.at(-1), 'test-host');

  const telemetrySnapshot = telemetry.snapshot();
  assert.equal(telemetrySnapshot.counters.multiplex_miss, 1);
  assert.equal(telemetrySnapshot.counters.multiplex_hit, 1);
  assert.equal(telemetrySnapshot.timings.ssh_master_acquire.count, 2);
  assert.equal(telemetrySnapshot.timings.ssh_handshake.count, 1);

  const snapshot = manager.snapshot();
  assert.equal(snapshot.active_masters, 1);
  assert.equal(snapshot.masters.length, 1);
  assert.match(snapshot.masters[0].target_hash, /^[0-9a-f]{16}$/u);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(createdControlPath), false);
  assert.equal(serialized.includes('test-host'), false);
  assert.equal(serialized.includes('tester'), false);
  const inspected = manager.inspect('test-host');
  assert.deepEqual(inspected, {
    mode: 'auto',
    state: 'active',
    active: true,
    target_hash: snapshot.masters[0].target_hash,
  });
});

test('default control root keeps the Unix socket path short enough for OpenSSH temporary listener suffixes', async (t) => {
  const homeDir = await tempHome(t);
  let masterAlive = false;
  let createdControlPath = null;
  const execFileImpl = callbackExec(async (_executable, args) => {
    if (args.includes('-O') && args.includes('check')) {
      if (!masterAlive) throw execFailure();
      return {};
    }
    if (args.includes('-MNf')) {
      createdControlPath = controlPathFromCreateArgs(args);
      masterAlive = true;
      return {};
    }
    throw new Error(`unexpected args ${JSON.stringify(args)}`);
  });
  const manager = createSshMultiplexManager({
    homeDir,
    env: {},
    resolveTargetImpl: async () => resolved(),
    execFileImpl,
  });

  await manager.acquire('test-host');
  assert.ok(createdControlPath);
  assert.equal(
    createdControlPath.includes('/.ptext-ssh/') || createdControlPath.startsWith('/tmp/ptext-ssh-'),
    true,
  );
  assert.ok(
    Buffer.byteLength(createdControlPath, 'utf8') <= 80,
    `control path must leave room for OpenSSH temporary suffixes: ${createdControlPath}`,
  );
  await manager.closeAll();
});

test('stale owned socket is removed and recovered through one new master', async (t) => {
  const homeDir = await tempHome(t);
  let checkCount = 0;
  let createCount = 0;
  let controlPath;
  let forceStale = false;
  const telemetry = createTelemetry();
  const execFileImpl = callbackExec(async (_executable, args) => {
    if (args.includes('-O') && args.includes('check')) {
      checkCount += 1;
      if (forceStale || createCount === 0) throw execFailure();
      return { stdout: 'Master running\n' };
    }
    if (args.includes('-MNf')) {
      createCount += 1;
      controlPath = controlPathFromCreateArgs(args);
      await fs.writeFile(controlPath, `socket-${createCount}`);
      forceStale = false;
      return {};
    }
    throw new Error(`unexpected args ${JSON.stringify(args)}`);
  });

  const manager = createSshMultiplexManager({
    homeDir,
    env: {},
    resolveTargetImpl: async () => resolved(),
    execFileImpl,
    telemetry,
  });

  assert.equal((await manager.acquire('test-host')).state, 'miss');
  forceStale = true;
  const recovered = await manager.acquire('test-host');
  assert.equal(recovered.state, 'stale_recovered');
  assert.equal(createCount, 2);
  assert.ok(checkCount >= 4);
  assert.equal(telemetry.snapshot().counters.multiplex_stale_recovered, 1);
  assert.equal(await fs.readFile(controlPath, 'utf8'), 'socket-2');
});

test('auto mode falls back to one-shot transport while required mode fails closed on master creation failure', async (t) => {
  const homeDir = await tempHome(t);
  const createFailure = execFailure('master creation failed');
  const execFileImpl = callbackExec(async (_executable, args) => {
    if (args.includes('-O') && args.includes('check')) throw execFailure();
    if (args.includes('-MNf')) throw createFailure;
    throw new Error('unexpected invocation');
  });

  const autoTelemetry = createTelemetry();
  const auto = createSshMultiplexManager({
    homeDir,
    env: { PTEXT_SSH_MULTIPLEX: 'auto' },
    resolveTargetImpl: async () => resolved(),
    execFileImpl,
    telemetry: autoTelemetry,
  });
  assert.deepEqual(await auto.acquire('test-host'), { args: [], state: 'fallback' });
  assert.equal(autoTelemetry.snapshot().counters.multiplex_fallback, 1);

  const required = createSshMultiplexManager({
    homeDir,
    env: { PTEXT_SSH_MULTIPLEX: 'required' },
    resolveTargetImpl: async () => resolved(),
    execFileImpl,
  });
  await assert.rejects(
    required.acquire('test-host'),
    (error) => error?.category === 'transport_reconnect_failure'
      && /required.*master/i.test(error.message)
      && JSON.stringify(error.details ?? {}).includes(homeDir) === false,
  );
});

test('concurrent first acquires share one master creation promise', async (t) => {
  const homeDir = await tempHome(t);
  let createCalls = 0;
  let checkCalls = 0;
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  let signalCreateStarted;
  const createStarted = new Promise((resolve) => { signalCreateStarted = resolve; });
  let masterAlive = false;

  const execFileImpl = callbackExec(async (_executable, args) => {
    if (args.includes('-O') && args.includes('check')) {
      checkCalls += 1;
      if (!masterAlive) throw execFailure();
      return {};
    }
    if (args.includes('-MNf')) {
      createCalls += 1;
      signalCreateStarted();
      await createGate;
      masterAlive = true;
      return {};
    }
    throw new Error('unexpected invocation');
  });

  const manager = createSshMultiplexManager({
    homeDir,
    env: {},
    resolveTargetImpl: async () => resolved(),
    execFileImpl,
  });

  const one = manager.acquire('test-host');
  const two = manager.acquire('test-host');
  await createStarted;
  assert.equal(createCalls, 1);
  releaseCreate();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(createCalls, 1);
  assert.equal(checkCalls, 2, 'one pre-create check plus one post-create proof');
  assert.equal(first.state, 'miss');
  assert.deepEqual(second, first);
});

test('max target bound evicts only a runtime-owned oldest master', async (t) => {
  const homeDir = await tempHome(t);
  const alive = new Set();
  const exits = [];
  let now = 1000;
  const execFileImpl = callbackExec(async (_executable, args) => {
    const target = args.at(-1);
    if (args.includes('-O') && args.includes('check')) {
      if (!alive.has(target)) throw execFailure();
      return {};
    }
    if (args.includes('-O') && args.includes('exit')) {
      exits.push(target);
      alive.delete(target);
      return {};
    }
    if (args.includes('-MNf')) {
      alive.add(target);
      return {};
    }
    throw new Error(`unexpected args ${JSON.stringify(args)}`);
  });
  const manager = createSshMultiplexManager({
    homeDir,
    env: { PTEXT_SSH_CONTROL_MAX_TARGETS: '1' },
    resolveTargetImpl: async (alias) => resolved(alias),
    execFileImpl,
    now: () => now++,
  });

  await manager.acquire('first-host');
  await manager.acquire('second-host');
  assert.deepEqual(exits, ['first-host']);
  assert.equal(manager.snapshot().active_masters, 1);
});

test('inspect is secret-safe and reports off or inactive without creating a master', async () => {
  const off = createSshMultiplexManager({ env: { PTEXT_SSH_MULTIPLEX: 'off' } });
  assert.deepEqual(off.inspect('test-host'), {
    mode: 'off',
    state: 'off',
    active: false,
    target_hash: null,
  });
});

