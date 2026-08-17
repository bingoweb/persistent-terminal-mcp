import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalError } from '../src/errors.mjs';
import { diagnoseTarget } from '../src/target-diagnostics.mjs';

function capabilities(overrides = {}) {
  const names = [
    'python3', 'rsync', 'sudo', 'docker', 'su', 'systemctl', 'journalctl', 'ss',
    'nvidia-smi', 'curl', 'openssl', 'dig', 'getent', 'ip', 'traceroute', 'mtr', 'ai-tmux',
  ];
  const result = Object.fromEntries(names.map((name) => [name, { available: false, version: null }]));
  for (const [name, value] of Object.entries({
    python3: { available: true, version: 'Python 3.12.3' },
    sudo: { available: true, version: 'Sudo 1.9' },
    systemctl: { available: true, version: 'systemd 258' },
    journalctl: { available: true, version: 'systemd 258' },
    ss: { available: true, version: 'iproute2' },
    'nvidia-smi': { available: true, version: '590.0' },
    'ai-tmux': { available: true, version: 'ai-tmux v0.11.7' },
    ...overrides,
  })) result[name] = value;
  return result;
}

function inventory(overrides = {}) {
  return {
    target: 'test-host',
    identity: { hostname: '203.0.113.30', user: 'tester', port: 22, proxy_jump: null },
    user: 'tester',
    uid: 1000,
    capabilities: capabilities(),
    root_providers: {
      direct_root: false,
      sudo_nopasswd: true,
      docker_host_root: false,
      sudo_password: true,
      su_root_password: true,
    },
    collected_at: '2026-08-17T08:45:00.000Z',
    expires_at: '2026-08-17T08:47:00.000Z',
    cache: { status: 'hit', ttl_ms: 120000 },
    ...overrides,
  };
}

function telemetrySnapshot() {
  return {
    timings: {
      remote_execution: {
        count: 4,
        total_ms: 400,
        min_ms: 40,
        max_ms: 180,
        average_ms: 100,
        buckets: {
          le_10_ms: 0, le_50_ms: 1, le_100_ms: 2, le_500_ms: 1, le_1000_ms: 0, gt_1000_ms: 0,
        },
      },
    },
    counters: { multiplex_hit: 3, multiplex_miss: 1, multiplex_fallback: 0 },
  };
}

function baseDeps(overrides = {}) {
  return {
    capabilityInventory: {
      get: async () => inventory(),
      snapshot: () => ({ entries: 1, pending: 0, ttl_ms: 120000, target_hashes: ['must-not-leak'] }),
    },
    multiplexManager: {
      inspect: () => ({ mode: 'auto', state: 'active', active: true, target_hash: '0123456789abcdef' }),
    },
    privilegeEngine: {
      snapshot: () => ({
        ttl_ms: 120000,
        entries: 1,
        providers: { direct_root: 0, sudo_nopasswd: 1, docker_host_root: 0 },
      }),
    },
    telemetry: { snapshot: () => telemetrySnapshot() },
    systemInfoImpl: async () => ({
      target: 'test-host',
      hostname: 'ubuntu-box',
      kernel: '7.0.0-29-generic',
      architecture: 'x86_64',
      os: { id: 'ubuntu', version: '26.04', pretty_name: 'Ubuntu 26.04' },
      uptime_seconds: 12345,
      raw: 'SYSTEM_RAW_MUST_NOT_LEAK',
      raw_truncated: false,
    }),
    diskUsageImpl: async () => ({
      target: 'test-host',
      filesystems: [
        { filesystem: '/dev/root', size_bytes: 1000, used_bytes: 710, available_bytes: 290, use_percent: 71, mountpoint: '/' },
        { filesystem: '/dev/data', size_bytes: 2000, used_bytes: 1800, available_bytes: 200, use_percent: 90, mountpoint: '/srv' },
      ],
      raw: 'DF_RAW_MUST_NOT_LEAK',
      raw_truncated: false,
    }),
    gpuInfoImpl: async () => ({
      target: 'test-host', provider: 'nvidia-smi', available: true,
      gpus: [{ index: 0, name: 'GPU', uuid: 'GPU-SECRETISH-ID', utilization_percent: 12 }],
      raw: 'GPU_RAW_MUST_NOT_LEAK', raw_truncated: false,
    }),
    remoteExecImpl: async (request) => {
      assert.equal(request.command, 'systemctl list-units --failed --no-legend --no-pager --plain');
      assert.deepEqual(request.env, { LC_ALL: 'C' });
      assert.equal(request.timeout_ms, 10000);
      assert.equal(request.max_output_bytes, 65536);
      return {
        exit_code: 0,
        stdout: 'broken-a.service loaded failed failed A\nbroken-b.timer loaded failed failed B\n',
        stderr: '', duration_ms: 3, timed_out: false, truncated: false,
      };
    },
    ...overrides,
  };
}

test('diagnoseTarget synthesizes complete bounded evidence without raw payloads or cache target hashes', async () => {
  const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps());

  assert.equal(result.state, 'available');
  assert.deepEqual(result.transport, {
    state: 'available',
    identity: inventory().identity,
    multiplex: { mode: 'auto', state: 'active', active: true, target_hash: '0123456789abcdef' },
  });
  assert.deepEqual(result.remote_identity, { state: 'available', user: 'tester', uid: 1000 });
  assert.deepEqual(result.system, {
    state: 'available',
    hostname: 'ubuntu-box',
    kernel: '7.0.0-29-generic',
    architecture: 'x86_64',
    os: { id: 'ubuntu', version: '26.04', pretty_name: 'Ubuntu 26.04' },
    uptime_seconds: 12345,
  });
  assert.deepEqual(result.disk_pressure, {
    state: 'available', filesystem_count: 2, highest_use_percent: 90, root_use_percent: 71,
  });
  assert.deepEqual(result.failed_systemd_units, { state: 'available', count: 2 });
  assert.deepEqual(result.gpu, { state: 'available', provider: 'nvidia-smi', count: 1 });
  assert.deepEqual(result.privilege, {
    state: 'available',
    root_providers: inventory().root_providers,
    cache: {
      state: 'available', ttl_ms: 120000, entries: 1,
      providers: { direct_root: 0, sudo_nopasswd: 1, docker_host_root: 0 },
    },
  });
  assert.deepEqual(result.capability_cache, {
    state: 'available', status: 'hit', ttl_ms: 120000, entries: 1, pending: 0,
  });
  assert.deepEqual(result.ai_tmux, { state: 'available', version: 'ai-tmux v0.11.7' });
  assert.deepEqual(result.telemetry, { state: 'available', ...telemetrySnapshot() });
  assert.equal(JSON.stringify(result).includes('RAW_MUST_NOT_LEAK'), false);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('GPU-SECRETISH-ID'), false);
});

test('disk pressure recomputes percentages from byte counts and handles a missing root mount', async () => {
  const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps({
    diskUsageImpl: async () => ({
      filesystems: [
        { filesystem: 'a', size_bytes: 3, used_bytes: 2, available_bytes: 1, use_percent: 1, mountpoint: '/srv/a' },
        { filesystem: 'b', size_bytes: 8, used_bytes: 7, available_bytes: 1, use_percent: 2, mountpoint: '/srv/b' },
      ],
    }),
  }));
  assert.deepEqual(result.disk_pressure, {
    state: 'available', filesystem_count: 2, highest_use_percent: 87.5, root_use_percent: null,
  });
});

test('missing optional capabilities become not-applicable or unavailable without invoking their probes', async () => {
  let gpuCalls = 0;
  let systemdCalls = 0;
  const value = inventory({
    capabilities: capabilities({
      'nvidia-smi': { available: false, version: null },
      systemctl: { available: false, version: null },
    }),
  });
  const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps({
    capabilityInventory: {
      get: async () => value,
      snapshot: () => ({ entries: 1, pending: 0, ttl_ms: 120000, target_hashes: [] }),
    },
    gpuInfoImpl: async () => { gpuCalls += 1; throw new Error('must not probe missing GPU capability'); },
    remoteExecImpl: async () => { systemdCalls += 1; throw new Error('must not probe missing systemctl capability'); },
  }));
  assert.equal(result.state, 'available');
  assert.deepEqual(result.gpu, { state: 'not_applicable', provider: 'nvidia-smi', count: 0 });
  assert.deepEqual(result.failed_systemd_units, { state: 'unavailable', count: null });
  assert.equal(gpuCalls, 0);
  assert.equal(systemdCalls, 0);
});

test('password-only root providers report permission_limited without touching any privilege execution API', async () => {
  const value = inventory({
    root_providers: {
      direct_root: false,
      sudo_nopasswd: false,
      docker_host_root: false,
      sudo_password: true,
      su_root_password: true,
    },
  });
  const privilegeEngine = {
    snapshot: () => ({
      ttl_ms: 120000, entries: 0,
      providers: { direct_root: 0, sudo_nopasswd: 0, docker_host_root: 0 },
    }),
    execute: async () => { throw new Error('diagnostics must never execute privilege providers'); },
  };
  const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps({
    capabilityInventory: {
      get: async () => value,
      snapshot: () => ({ entries: 1, pending: 0, ttl_ms: 120000, target_hashes: [] }),
    },
    privilegeEngine,
  }));
  assert.equal(result.privilege.state, 'permission_limited');
});

test('capability transport failure stays a diagnostic result and preserves safe multiplex and telemetry evidence', async () => {
  const result = await diagnoseTarget({ target: 'test-host', refresh: true }, baseDeps({
    capabilityInventory: {
      get: async () => { throw new TerminalError('transport_reconnect_failure', 'network reset', { retryable: true }); },
      snapshot: () => ({ entries: 0, pending: 0, ttl_ms: 120000, target_hashes: ['hidden'] }),
    },
  }));
  assert.equal(result.state, 'failure');
  assert.equal(result.transport.state, 'failure');
  assert.equal(result.transport.failure.category, 'transport_reconnect_failure');
  assert.deepEqual(result.remote_identity, { state: 'unavailable' });
  assert.deepEqual(result.system, { state: 'unavailable' });
  assert.deepEqual(result.disk_pressure, { state: 'unavailable', filesystem_count: null, highest_use_percent: null, root_use_percent: null });
  assert.deepEqual(result.failed_systemd_units, { state: 'unavailable', count: null });
  assert.deepEqual(result.gpu, { state: 'not_applicable', provider: 'nvidia-smi', count: 0 });
  assert.equal(result.telemetry.state, 'available');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('independent read-only probe failures degrade only their sections and preserve successful evidence', async () => {
  const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps({
    systemInfoImpl: async () => { throw new TerminalError('remote_command_nonzero_exit', 'uname failed'); },
    diskUsageImpl: async () => { throw new TerminalError('remote_command_nonzero_exit', 'df failed'); },
    gpuInfoImpl: async () => { throw new TerminalError('remote_command_nonzero_exit', 'nvidia failed'); },
    remoteExecImpl: async () => {
      throw new TerminalError('permission_privilege_error', 'systemd list denied');
    },
  }));
  assert.equal(result.state, 'degraded');
  assert.equal(result.transport.state, 'available');
  assert.equal(result.system.state, 'failure');
  assert.equal(result.system.failure.category, 'remote_command_nonzero_exit');
  assert.equal(result.disk_pressure.state, 'failure');
  assert.equal(result.disk_pressure.failure.category, 'remote_command_nonzero_exit');
  assert.equal(result.disk_pressure.filesystem_count, null);
  assert.equal(result.disk_pressure.highest_use_percent, null);
  assert.equal(result.disk_pressure.root_use_percent, null);
  assert.deepEqual(result.failed_systemd_units, { state: 'permission_limited', count: null });
  assert.equal(result.gpu.state, 'failure');
  assert.equal(result.gpu.failure.category, 'remote_command_nonzero_exit');
  assert.equal(result.capabilities.python3.available, true);
});

test('telemetry and cache snapshot failures are isolated as unavailable evidence and never fail diagnosis', async () => {
  const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps({
    capabilityInventory: {
      get: async () => inventory(),
      snapshot: () => { throw new Error('cache snapshot broke'); },
    },
    privilegeEngine: { snapshot: () => { throw new Error('privilege snapshot broke'); } },
    telemetry: { snapshot: () => { throw new Error('telemetry broke'); } },
    multiplexManager: { inspect: () => { throw new Error('inspect broke'); } },
  }));
  assert.equal(result.state, 'available');
  assert.deepEqual(result.transport.multiplex, {
    mode: 'unmanaged', state: 'unavailable', active: false, target_hash: null,
  });
  assert.deepEqual(result.capability_cache, {
    state: 'unavailable', status: 'hit', ttl_ms: 120000, entries: null, pending: null,
  });
  assert.deepEqual(result.privilege.cache, {
    state: 'unavailable', ttl_ms: null, entries: null,
    providers: { direct_root: 0, sudo_nopasswd: 0, docker_host_root: 0 },
  });
  assert.deepEqual(result.telemetry, { state: 'unavailable', timings: {}, counters: {} });
});

test('telemetry evidence is reduced to the fixed metric vocabulary and cannot carry arbitrary payload labels', async () => {
  const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps({
    telemetry: {
      snapshot: () => ({
        timings: {
          remote_execution: {
            count: 1,
            total_ms: 5,
            min_ms: 5,
            max_ms: 5,
            average_ms: 5,
            buckets: {
              le_10_ms: 1,
              le_50_ms: 0,
              le_100_ms: 0,
              le_500_ms: 0,
              le_1000_ms: 0,
              gt_1000_ms: 0,
            },
            command: 'SECRET COMMAND MUST NOT LEAK',
          },
          arbitrary_payload_metric: { command: 'SECRET COMMAND MUST NOT LEAK' },
        },
        counters: {
          multiplex_hit: 1,
          arbitrary_target_label: 99,
        },
        command: 'SECRET COMMAND MUST NOT LEAK',
      }),
    },
  }));
  assert.deepEqual(Object.keys(result.telemetry.timings), ['remote_execution']);
  assert.deepEqual(Object.keys(result.telemetry.counters), ['multiplex_hit']);
  assert.equal(JSON.stringify(result.telemetry).includes('SECRET COMMAND MUST NOT LEAK'), false);
  assert.equal(JSON.stringify(result.telemetry).includes('arbitrary'), false);
});

test('failed-systemd probe counts bounded non-empty rows and treats timeout/truncation as failures', async () => {
  for (const execution of [
    { exit_code: 0, stdout: 'a.service loaded failed failed A\n\n b.timer loaded failed failed B\n', stderr: '', timed_out: false, truncated: false },
    { exit_code: null, stdout: '', stderr: '', timed_out: true, truncated: false },
    { exit_code: 0, stdout: 'partial', stderr: '', timed_out: false, truncated: true },
  ]) {
    const result = await diagnoseTarget({ target: 'test-host', refresh: false }, baseDeps({
      remoteExecImpl: async () => execution,
    }));
    if (!execution.timed_out && !execution.truncated) {
      assert.deepEqual(result.failed_systemd_units, { state: 'available', count: 2 });
    } else {
      assert.equal(result.state, 'degraded');
      assert.equal(result.failed_systemd_units.state, 'failure');
      assert.ok(['timeout', 'local_capability_dependency_error'].includes(result.failed_systemd_units.failure.category));
    }
  }
});
