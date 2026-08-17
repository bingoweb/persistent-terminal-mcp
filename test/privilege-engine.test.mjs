import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalError } from '../src/errors.mjs';
import { createPrivilegeEngine } from '../src/privilege-engine.mjs';
import { createTelemetry } from '../src/telemetry.mjs';

function inventory(overrides = {}) {
  return {
    target: 'test-host',
    identity: { hostname: '203.0.113.40', user: 'tester', port: 22, proxy_jump: null },
    user: 'tester',
    uid: 1000,
    root_providers: {
      direct_root: false,
      sudo_nopasswd: true,
      docker_host_root: true,
      sudo_password: true,
      su_root_password: true,
    },
    expires_at: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function rootResult(strategy, attempts = [{ strategy, status: 'selected' }]) {
  return {
    strategy,
    target: 'test-host',
    exit_code: 0,
    stdout: '0\n',
    stderr: '',
    duration_ms: 4,
    timed_out: false,
    truncated: false,
    attempts,
  };
}

test('first privileged execution uses default order and caches a proven non-secret provider preference', async () => {
  let now = 1_000;
  const rootCalls = [];
  const engine = createPrivilegeEngine({
    ttlMs: 120_000,
    now: () => now,
    capabilityInventory: { get: async () => inventory() },
    rootExecImpl: async (request, deps) => {
      rootCalls.push({ request: structuredClone(request), deps: structuredClone(deps) });
      return rootResult('sudo_nopasswd');
    },
  });

  const result = await engine.execute({ target: 'test-host', command: 'id -u' });
  assert.equal(result.strategy, 'sudo_nopasswd');
  assert.deepEqual(rootCalls[0].deps.providerOrder, [
    'direct_root', 'sudo_nopasswd', 'docker_host_root', 'sudo_password', 'su_root_password',
  ]);
  assert.deepEqual(rootCalls[0].deps.capabilityHint, inventory().root_providers);
  assert.deepEqual(engine.snapshot(), {
    ttl_ms: 120000,
    entries: 1,
    providers: { direct_root: 0, sudo_nopasswd: 1, docker_host_root: 0 },
  });
});

test('cached non-secret provider is preferred on the next call but execution is never coalesced', async () => {
  const orders = [];
  let executions = 0;
  const engine = createPrivilegeEngine({
    capabilityInventory: { get: async () => inventory() },
    rootExecImpl: async (_request, deps) => {
      executions += 1;
      orders.push([...deps.providerOrder]);
      return rootResult('sudo_nopasswd');
    },
  });

  await engine.execute({ target: 'test-host', command: 'true' });
  await Promise.all([
    engine.execute({ target: 'test-host', command: 'printf one' }),
    engine.execute({ target: 'test-host', command: 'printf two' }),
  ]);

  assert.equal(executions, 3, 'privileged commands must remain distinct executions');
  assert.deepEqual(orders[0], [
    'direct_root', 'sudo_nopasswd', 'docker_host_root', 'sudo_password', 'su_root_password',
  ]);
  assert.equal(orders[1][0], 'sudo_nopasswd');
  assert.equal(orders[2][0], 'sudo_nopasswd');
});

test('TTL expiry and SSH identity change discard provider preference', async () => {
  let clock = 10_000;
  let currentIdentity = '203.0.113.40';
  const orders = [];
  const engine = createPrivilegeEngine({
    ttlMs: 100,
    now: () => clock,
    capabilityInventory: {
      get: async () => inventory({
        identity: { hostname: currentIdentity, user: 'tester', port: 22, proxy_jump: null },
      }),
    },
    rootExecImpl: async (_request, deps) => {
      orders.push([...deps.providerOrder]);
      return rootResult('docker_host_root');
    },
  });

  await engine.execute({ target: 'test-host', command: 'true' });
  clock += 50;
  await engine.execute({ target: 'test-host', command: 'true' });
  assert.equal(orders[1][0], 'docker_host_root');

  clock += 101;
  await engine.execute({ target: 'test-host', command: 'true' });
  assert.equal(orders[2][0], 'direct_root', 'expired preference must use policy order');

  currentIdentity = '203.0.113.41';
  await engine.execute({ target: 'test-host', command: 'true' });
  assert.equal(orders[3][0], 'direct_root', 'identity change must invalidate prior preference');
});

test('proof failure result selecting a different provider replaces the stale cached preference', async () => {
  const orders = [];
  let call = 0;
  const engine = createPrivilegeEngine({
    capabilityInventory: { get: async () => inventory() },
    rootExecImpl: async (_request, deps) => {
      call += 1;
      orders.push([...deps.providerOrder]);
      if (call === 1) return rootResult('sudo_nopasswd');
      return rootResult('docker_host_root', [
        { strategy: 'sudo_nopasswd', status: 'unavailable' },
        { strategy: 'docker_host_root', status: 'selected' },
      ]);
    },
  });

  await engine.execute({ target: 'test-host', command: 'true' });
  const second = await engine.execute({ target: 'test-host', command: 'true' });
  const third = await engine.execute({ target: 'test-host', command: 'true' });
  assert.equal(orders[1][0], 'sudo_nopasswd');
  assert.equal(second.strategy, 'docker_host_root');
  assert.equal(orders[2][0], 'docker_host_root');
  assert.equal(third.strategy, 'docker_host_root');
});

test('password provider success is never cached as an automatic preference', async () => {
  const orders = [];
  const engine = createPrivilegeEngine({
    capabilityInventory: { get: async () => inventory() },
    rootExecImpl: async (_request, deps) => {
      orders.push([...deps.providerOrder]);
      return rootResult('sudo_password');
    },
  });

  await engine.execute({ target: 'test-host', command: 'true' });
  await engine.execute({ target: 'test-host', command: 'true' });
  assert.equal(orders[0][0], 'direct_root');
  assert.equal(orders[1][0], 'direct_root');
  assert.equal(engine.snapshot().entries, 0);
});

test('known unavailable providers are passed as hints but a cached preference is discarded if inventory now says unavailable', async () => {
  let sudoAvailable = true;
  const calls = [];
  const engine = createPrivilegeEngine({
    capabilityInventory: {
      get: async () => inventory({
        root_providers: {
          ...inventory().root_providers,
          sudo_nopasswd: sudoAvailable,
        },
      }),
    },
    rootExecImpl: async (_request, deps) => {
      calls.push(structuredClone(deps));
      return rootResult(sudoAvailable ? 'sudo_nopasswd' : 'docker_host_root');
    },
  });

  await engine.execute({ target: 'test-host', command: 'true' });
  sudoAvailable = false;
  await engine.execute({ target: 'test-host', command: 'true' });
  assert.equal(calls[1].providerOrder[0], 'direct_root');
  assert.equal(calls[1].capabilityHint.sudo_nopasswd, false);
});

test('failed root execution is not converted into a cache entry and telemetry remains bounded', async () => {
  const telemetry = createTelemetry();
  const engine = createPrivilegeEngine({
    telemetry,
    capabilityInventory: { get: async () => inventory() },
    rootExecImpl: async () => {
      throw new TerminalError('permission_privilege_error', 'no root provider');
    },
  });
  await assert.rejects(
    engine.execute({ target: 'test-host', command: 'true' }),
    (error) => error?.category === 'permission_privilege_error',
  );
  assert.equal(engine.snapshot().entries, 0);
  assert.equal(telemetry.snapshot().timings.root_provider.count, 1);
});

test('invalidate removes one target or all cached preferences', async () => {
  const engine = createPrivilegeEngine({
    capabilityInventory: {
      get: async (target) => inventory({ target, identity: { hostname: target, user: 'tester', port: 22, proxy_jump: null } }),
    },
    rootExecImpl: async (request) => ({ ...rootResult('sudo_nopasswd'), target: request.target }),
  });
  await engine.execute({ target: 'one', command: 'true' });
  await engine.execute({ target: 'two', command: 'true' });
  assert.equal(engine.snapshot().entries, 2);
  assert.equal(engine.invalidate('one'), 1);
  assert.equal(engine.snapshot().entries, 1);
  assert.equal(engine.invalidate(), 1);
  assert.equal(engine.snapshot().entries, 0);
});
