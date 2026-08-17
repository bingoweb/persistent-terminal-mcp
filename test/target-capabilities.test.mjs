import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalError } from '../src/errors.mjs';
import {
  CAPABILITY_PROBE_COMMAND,
  ROOT_PROVIDER_NAMES,
  TARGET_CAPABILITY_NAMES,
  createCapabilityInventory,
} from '../src/target-capabilities.mjs';
import { createTelemetry } from '../src/telemetry.mjs';

function resolved(alias = 'test-host', overrides = {}) {
  return {
    alias,
    host: alias,
    hostname: '203.0.113.30',
    user: 'tester',
    port: 22,
    proxyJump: 'none',
    identityFile: '/Users/tester/.ssh/SECRET_KEY_PATH_MUST_NOT_APPEAR',
    strictHostKeyChecking: 'ask',
    ...overrides,
  };
}

function commandResult(stdout, overrides = {}) {
  return {
    exit_code: 0,
    stdout,
    stderr: '',
    duration_ms: 8,
    timed_out: false,
    truncated: false,
    ...overrides,
  };
}

function probeOutput(overrides = []) {
  return [
    'protocol=1',
    'uid=1000',
    'user=tester',
    'cap.python3.available=1',
    'cap.python3.version=Python 3.12.3',
    'cap.rsync.available=0',
    'cap.sudo.available=1',
    'cap.sudo.version=Sudo version 1.9.15p5',
    'cap.docker.available=1',
    'cap.docker.version=Docker version 28.0.1',
    'cap.ai-tmux.available=1',
    'cap.ai-tmux.version=ai-tmux v0.11.7',
    'root.direct_root=0',
    'root.sudo_nopasswd=1',
    'root.docker_host_root=1',
    'root.sudo_password=1',
    'root.su_root_password=1',
    ...overrides,
    '',
  ].join('\n');
}

test('capability vocabulary is fixed and includes administration, transfer, diagnostics and ai-tmux primitives', () => {
  assert.deepEqual([...TARGET_CAPABILITY_NAMES], [
    'python3', 'rsync', 'sudo', 'docker', 'su', 'systemctl', 'journalctl', 'ss',
    'nvidia-smi', 'curl', 'openssl', 'dig', 'getent', 'ip', 'traceroute', 'mtr', 'ai-tmux',
  ]);
  assert.deepEqual([...ROOT_PROVIDER_NAMES], [
    'direct_root', 'sudo_nopasswd', 'docker_host_root', 'sudo_password', 'su_root_password',
  ]);
});

test('capability inventory validates target before resolution or remote execution', async () => {
  let resolveCalls = 0;
  let remoteCalls = 0;
  const inventory = createCapabilityInventory({
    resolveTargetImpl: async () => { resolveCalls += 1; return resolved(); },
    remoteExecImpl: async () => { remoteCalls += 1; return commandResult(probeOutput()); },
  });

  for (const target of ['', 'bad\0target', ' bad target ']) {
    await assert.rejects(
      inventory.get(target),
      (error) => error?.category === 'validation_error',
    );
  }
  assert.equal(resolveCalls, 0);
  assert.equal(remoteCalls, 0);
});

test('one bounded fixed probe is normalized without exposing SSH key material or raw environment data', async () => {
  const calls = [];
  const now = () => Date.parse('2026-08-17T08:45:00.000Z');
  const inventory = createCapabilityInventory({
    ttlMs: 120_000,
    now,
    resolveTargetImpl: async () => resolved(),
    remoteExecImpl: async (request) => {
      calls.push(structuredClone(request));
      return commandResult(probeOutput());
    },
  });

  const result = await inventory.get('test-host');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    target: 'test-host',
    command: CAPABILITY_PROBE_COMMAND,
    env: { LC_ALL: 'C' },
    timeout_ms: 15_000,
    max_output_bytes: 65_536,
  });
  assert.equal(CAPABILITY_PROBE_COMMAND.includes('test-host'), false);

  assert.deepEqual(result.identity, {
    hostname: '203.0.113.30',
    user: 'tester',
    port: 22,
    proxy_jump: null,
  });
  assert.equal(result.target, 'test-host');
  assert.equal(result.uid, 1000);
  assert.equal(result.user, 'tester');
  assert.deepEqual(result.capabilities.python3, { available: true, version: 'Python 3.12.3' });
  assert.deepEqual(result.capabilities.rsync, { available: false, version: null });
  assert.deepEqual(result.capabilities.docker, { available: true, version: 'Docker version 28.0.1' });
  assert.deepEqual(result.capabilities['ai-tmux'], { available: true, version: 'ai-tmux v0.11.7' });
  assert.deepEqual(result.capabilities.systemctl, { available: false, version: null });
  assert.deepEqual(result.root_providers, {
    direct_root: false,
    sudo_nopasswd: true,
    docker_host_root: true,
    sudo_password: true,
    su_root_password: true,
  });
  assert.equal(result.collected_at, '2026-08-17T08:45:00.000Z');
  assert.equal(result.expires_at, '2026-08-17T08:47:00.000Z');
  assert.deepEqual(result.cache, { status: 'miss', ttl_ms: 120_000 });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('SECRET_KEY_PATH_MUST_NOT_APPEAR'), false);
  assert.equal(serialized.includes('identityFile'), false);
  assert.equal(serialized.includes('strictHostKeyChecking'), false);
  assert.equal(serialized.includes('process.env'), false);
});

test('successful positive and negative capability results are reused until TTL expiry', async () => {
  let clock = 1_000_000;
  let remoteCalls = 0;
  const telemetry = createTelemetry();
  const inventory = createCapabilityInventory({
    ttlMs: 120_000,
    now: () => clock,
    telemetry,
    resolveTargetImpl: async () => resolved(),
    remoteExecImpl: async () => {
      remoteCalls += 1;
      return commandResult(probeOutput());
    },
  });

  const first = await inventory.get('test-host');
  clock += 30_000;
  const cached = await inventory.get('test-host');
  assert.equal(remoteCalls, 1);
  assert.equal(first.cache.status, 'miss');
  assert.equal(cached.cache.status, 'hit');
  assert.equal(cached.capabilities.rsync.available, false, 'negative capability must also be cached');

  clock += 120_001;
  const expired = await inventory.get('test-host');
  assert.equal(remoteCalls, 2);
  assert.equal(expired.cache.status, 'miss');
  const counters = telemetry.snapshot().counters;
  assert.equal(counters.capability_cache_hit, 1);
  assert.equal(counters.capability_cache_miss, 2);
});

test('explicit refresh bypasses a valid cache entry and is visible in telemetry', async () => {
  let remoteCalls = 0;
  const telemetry = createTelemetry();
  const inventory = createCapabilityInventory({
    telemetry,
    resolveTargetImpl: async () => resolved(),
    remoteExecImpl: async () => {
      remoteCalls += 1;
      return commandResult(probeOutput([`cap.curl.version=curl refresh-${remoteCalls}`]));
    },
  });

  await inventory.get('test-host');
  const refreshed = await inventory.get('test-host', { refresh: true });
  assert.equal(remoteCalls, 2);
  assert.equal(refreshed.cache.status, 'refresh');
  assert.equal(telemetry.snapshot().counters.capability_cache_refresh, 1);
});

test('resolved SSH identity change invalidates an otherwise fresh cache entry', async () => {
  let resolution = 0;
  let remoteCalls = 0;
  const inventory = createCapabilityInventory({
    resolveTargetImpl: async () => {
      resolution += 1;
      return resolved('test-host', { hostname: resolution === 1 ? '203.0.113.30' : '203.0.113.31' });
    },
    remoteExecImpl: async () => {
      remoteCalls += 1;
      return commandResult(probeOutput());
    },
  });

  const first = await inventory.get('test-host');
  const second = await inventory.get('test-host');
  assert.equal(first.identity.hostname, '203.0.113.30');
  assert.equal(second.identity.hostname, '203.0.113.31');
  assert.equal(remoteCalls, 2);
});

test('transport failure is never cached and the next request probes again', async () => {
  let remoteCalls = 0;
  const inventory = createCapabilityInventory({
    resolveTargetImpl: async () => resolved(),
    remoteExecImpl: async () => {
      remoteCalls += 1;
      if (remoteCalls === 1) {
        throw new TerminalError('transport_reconnect_failure', 'link reset', { retryable: true });
      }
      return commandResult(probeOutput());
    },
  });

  await assert.rejects(
    inventory.get('test-host'),
    (error) => error?.category === 'transport_reconnect_failure',
  );
  const recovered = await inventory.get('test-host');
  assert.equal(remoteCalls, 2);
  assert.equal(recovered.cache.status, 'miss');
});

test('concurrent cache misses for one target share one resolution and one remote probe', async () => {
  let resolveCalls = 0;
  let remoteCalls = 0;
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let signalProbeStarted;
  const probeStarted = new Promise((resolve) => { signalProbeStarted = resolve; });
  const inventory = createCapabilityInventory({
    resolveTargetImpl: async () => { resolveCalls += 1; return resolved(); },
    remoteExecImpl: async () => {
      remoteCalls += 1;
      signalProbeStarted();
      await probeGate;
      return commandResult(probeOutput());
    },
  });

  const one = inventory.get('test-host');
  const two = inventory.get('test-host');
  await probeStarted;
  assert.equal(resolveCalls, 1);
  assert.equal(remoteCalls, 1);
  releaseProbe();
  const [first, second] = await Promise.all([one, two]);
  assert.deepEqual(second, first);
});

test('non-zero or malformed capability probe results fail explicitly instead of becoming cache entries', async () => {
  for (const result of [
    commandResult('', { exit_code: 3, stderr: 'probe failed' }),
    commandResult('protocol=2\nuid=1000\nuser=tester\n'),
    commandResult('protocol=1\nuid=not-a-number\nuser=tester\n'),
  ]) {
    let calls = 0;
    const inventory = createCapabilityInventory({
      resolveTargetImpl: async () => resolved(),
      remoteExecImpl: async () => { calls += 1; return result; },
    });
    await assert.rejects(inventory.get('test-host'));
    await assert.rejects(inventory.get('test-host'));
    assert.equal(calls, 2, 'failed probe must not populate cache');
  }
});

