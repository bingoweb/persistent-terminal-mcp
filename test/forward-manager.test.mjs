import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createForwardManager } from '../src/forward-manager.mjs';

const DEFINITION = Object.freeze({
  forward_id: 'fwd_00112233445566778899aabb',
  name: 'web',
  target: 'taylan',
  type: 'local',
  bind_address: '127.0.0.1',
  listen_port: 18080,
  destination_host: '127.0.0.1',
  destination_port: 8080,
});

const IDENTITY = Object.freeze({
  started_at: 'Mon Aug 17 08:00:00 2026',
  identity: 'process-identity-a',
});

function fakeStateStore(initial = {}) {
  const records = new Map(Array.isArray(initial) ? initial : Object.entries(initial));
  const calls = [];
  return {
    calls,
    async listForwards() {
      return [...records.values()].map((value) => structuredClone(value));
    },
    async getForward(id) {
      const value = records.get(id);
      return value === undefined ? null : structuredClone(value);
    },
    async putForward(record) {
      calls.push({ op: 'put', record: structuredClone(record) });
      records.set(record.forward_id, structuredClone(record));
      return structuredClone(record);
    },
    async deleteForward(id) {
      calls.push({ op: 'delete', id });
      records.delete(id);
    },
  };
}

function spawnedChild({ pid = 4242, exit = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    child.emit('spawn');
    if (exit) child.emit('exit', exit.code, exit.signal ?? null);
  });
  return child;
}

test('create spawns ssh -N argv and persists pid/start identity only after startup succeeds', async () => {
  const store = fakeStateStore();
  const spawns = [];
  const manager = createForwardManager({
    stateStore: store,
    spawnImpl: (executable, args, options) => {
      spawns.push({ executable, args, options });
      return spawnedChild();
    },
    readProcessIdentityImpl: async () => IDENTITY,
    waitImpl: async () => {},
    nowImpl: () => new Date('2026-08-17T05:00:00.000Z'),
  });

  const record = await manager.create(DEFINITION);

  assert.equal(record.pid, 4242);
  assert.equal(record.process_started_at, IDENTITY.started_at);
  assert.equal(record.process_identity, IDENTITY.identity);
  assert.equal(record.created_at, '2026-08-17T05:00:00.000Z');
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].op, 'put');
  assert.deepEqual(spawns[0].args.slice(0, 2), ['-N', '-T']);
  assert.equal(spawns[0].executable, 'ssh');
  assert.equal(spawns[0].options.shell, false);
});

test('create does not persist a forward that exits during the bounded startup gate', async () => {
  const store = fakeStateStore();
  const manager = createForwardManager({
    stateStore: store,
    spawnImpl: () => spawnedChild({ exit: { code: 255 } }),
    readProcessIdentityImpl: async () => null,
    waitImpl: async () => new Promise((resolve) => setImmediate(resolve)),
  });

  await assert.rejects(
    () => manager.create(DEFINITION),
    (error) => error.category === 'transport_reconnect_failure',
  );
  assert.deepEqual(store.calls, []);
});

test('close refuses stale/reused PID identity and never sends SIGTERM', async () => {
  const record = {
    ...DEFINITION,
    pid: 4242,
    process_started_at: IDENTITY.started_at,
    process_identity: IDENTITY.identity,
    created_at: '2026-08-17T05:00:00.000Z',
  };
  const store = fakeStateStore([[record.forward_id, record]]);
  const kills = [];
  const manager = createForwardManager({
    stateStore: store,
    readProcessIdentityImpl: async () => ({
      started_at: 'Mon Aug 17 08:01:00 2026',
      identity: 'different-process',
    }),
    killProcessImpl: (pid, signal) => kills.push({ pid, signal }),
    waitImpl: async () => {},
  });

  await assert.rejects(
    () => manager.close(record.forward_id),
    (error) => error.category === 'stale_session_task_forward_id',
  );
  assert.deepEqual(kills, []);
  assert.equal(store.calls.some((call) => call.op === 'delete'), false);
});

test('close sends SIGTERM then SIGKILL only while the recorded process identity still matches', async () => {
  const record = {
    ...DEFINITION,
    pid: 4242,
    process_started_at: IDENTITY.started_at,
    process_identity: IDENTITY.identity,
    created_at: '2026-08-17T05:00:00.000Z',
  };
  const store = fakeStateStore([[record.forward_id, record]]);
  const kills = [];
  const identities = [IDENTITY, IDENTITY, IDENTITY, null];
  const manager = createForwardManager({
    stateStore: store,
    readProcessIdentityImpl: async () => identities.shift() ?? null,
    killProcessImpl: (pid, signal) => kills.push({ pid, signal }),
    waitImpl: async () => {},
  });

  const result = await manager.close(record.forward_id);

  assert.deepEqual(kills, [
    { pid: 4242, signal: 'SIGTERM' },
    { pid: 4242, signal: 'SIGKILL' },
  ]);
  assert.equal(result.closed, true);
  assert.equal(result.forward_id, record.forward_id);
  assert.equal(store.calls.at(-1).op, 'delete');
});

test('close never SIGKILLs a PID that changed identity during the graceful wait', async () => {
  const record = {
    ...DEFINITION,
    pid: 4242,
    process_started_at: IDENTITY.started_at,
    process_identity: IDENTITY.identity,
    created_at: '2026-08-17T05:00:00.000Z',
  };
  const store = fakeStateStore([[record.forward_id, record]]);
  const kills = [];
  const identities = [
    IDENTITY,
    { started_at: 'Mon Aug 17 08:02:00 2026', identity: 'replacement-process' },
  ];
  const manager = createForwardManager({
    stateStore: store,
    readProcessIdentityImpl: async () => identities.shift() ?? null,
    killProcessImpl: (pid, signal) => kills.push({ pid, signal }),
    waitImpl: async () => {},
  });

  const result = await manager.close(record.forward_id);
  assert.deepEqual(kills, [{ pid: 4242, signal: 'SIGTERM' }]);
  assert.equal(result.closed, true);
  assert.equal(store.calls.at(-1).op, 'delete');
});
