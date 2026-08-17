import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalError } from '../src/errors.mjs';
import {
  TARGET_TOOLS,
  TARGET_TOOL_NAMES,
  callTargetTool,
} from '../src/target-tools.mjs';
import { LOCAL_TOOLS, buildToolCatalog, callTool } from '../src/tool-registry.mjs';

function inventoryResult() {
  return {
    target: 'test-host',
    identity: { hostname: '203.0.113.30', user: 'tester', port: 22, proxy_jump: null },
    user: 'tester',
    uid: 1000,
    capabilities: {
      python3: { available: true, version: 'Python 3.12.3' },
      rsync: { available: false, version: null },
      sudo: { available: true, version: 'Sudo 1.9' },
      docker: { available: false, version: null },
      su: { available: true, version: 'util-linux' },
      systemctl: { available: true, version: 'systemd 258' },
      journalctl: { available: true, version: 'systemd 258' },
      ss: { available: true, version: 'iproute2' },
      'nvidia-smi': { available: false, version: null },
      curl: { available: true, version: 'curl 8' },
      openssl: { available: true, version: 'OpenSSL 3' },
      dig: { available: false, version: null },
      getent: { available: true, version: 'glibc' },
      ip: { available: true, version: 'iproute2' },
      traceroute: { available: false, version: null },
      mtr: { available: false, version: null },
      'ai-tmux': { available: true, version: 'ai-tmux v0.11.7' },
    },
    root_providers: {
      direct_root: false,
      sudo_nopasswd: true,
      docker_host_root: false,
      sudo_password: true,
      su_root_password: true,
    },
    collected_at: '2026-08-17T08:45:00.000Z',
    expires_at: '2026-08-17T08:47:00.000Z',
    cache: { status: 'miss', ttl_ms: 120000 },
  };
}

test('target_capabilities publishes one closed canonical read-only schema', () => {
  assert.deepEqual(TARGET_TOOLS.map((tool) => tool.name), ['target_capabilities', 'target_diagnose']);
  const tool = TARGET_TOOLS.find((candidate) => candidate.name === 'target_capabilities');
  assert.equal(TARGET_TOOL_NAMES.has('target_capabilities'), true);
  assert.equal(LOCAL_TOOLS.some((candidate) => candidate.name === 'target_capabilities'), true);
  assert.deepEqual(tool.inputSchema.required, ['target']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.refresh, { type: 'boolean', default: false });
  assert.equal(tool.outputSchema.oneOf.length, 2);
  const success = tool.outputSchema.oneOf[0];
  assert.equal(success.additionalProperties, false);
  assert.equal('identity_file' in success.properties.identity.properties, false);
  assert.equal('control_path' in success.properties, false);
  assert.equal('password' in success.properties, false);
  assert.ok(buildToolCatalog({ upstreamTools: [] }).some((candidate) => candidate.name === 'target_capabilities'));
  assert.ok(buildToolCatalog({ upstreamTools: [] }).some((candidate) => candidate.name === 'target_diagnose'));
  const diagnose = TARGET_TOOLS.find((candidate) => candidate.name === 'target_diagnose');
  const diagnoseSuccess = diagnose.outputSchema.oneOf[0];
  for (const field of [
    'disk_pressure', 'failed_systemd_units', 'gpu', 'capability_cache', 'telemetry',
  ]) assert.ok(field in diagnoseSuccess.properties, `target_diagnose schema missing ${field}`);
  assert.equal(diagnoseSuccess.properties.telemetry.additionalProperties, false);
  assert.equal(diagnoseSuccess.properties.capability_cache.additionalProperties, false);
});

test('target_capabilities delegates to the inventory with explicit refresh semantics', async () => {
  const calls = [];
  const response = await callTargetTool(
    'target_capabilities',
    { target: 'test-host', refresh: true },
    {
      capabilityInventory: {
        async get(target, options) {
          calls.push({ target, options });
          return inventoryResult();
        },
      },
    },
  );
  assert.deepEqual(calls, [{ target: 'test-host', options: { refresh: true } }]);
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, inventoryResult());
});

test('target_capabilities rejects invalid refresh before touching the inventory', async () => {
  let calls = 0;
  const response = await callTargetTool(
    'target_capabilities',
    { target: 'test-host', refresh: 'yes' },
    { capabilityInventory: { get: async () => { calls += 1; } } },
  );
  assert.equal(calls, 0);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.category, 'validation_error');
});

test('target capability failures use the normalized MCP error contract', async () => {
  const response = await callTargetTool(
    'target_capabilities',
    { target: 'test-host' },
    {
      capabilityInventory: {
        get: async () => {
          throw new TerminalError('transport_reconnect_failure', 'connection lost', { retryable: true });
        },
      },
    },
  );
  assert.equal(response.isError, true);
  assert.deepEqual(response.structuredContent, {
    category: 'transport_reconnect_failure',
    message: 'connection lost',
    retryable: true,
  });
});

test('unified registry routes target_capabilities locally and never forwards it upstream', async () => {
  const targetCalls = [];
  const response = await callTool(
    'target_capabilities',
    { target: 'test-host' },
    {
      upstreamClient: { callTool: async () => { throw new Error('must not forward upstream'); } },
      upstreamToolNames: new Set(),
      targetToolCallImpl: async (name, args) => {
        targetCalls.push({ name, args });
        return { content: [], structuredContent: inventoryResult() };
      },
    },
  );
  assert.deepEqual(targetCalls, [{ name: 'target_capabilities', args: { target: 'test-host' } }]);
  assert.deepEqual(response.structuredContent, inventoryResult());
});

test('target_diagnose synthesizes transport system privilege ai-tmux cache and telemetry evidence', async () => {
  const telemetrySnapshot = {
    timings: { remote_execution: { count: 2 } },
    counters: { multiplex_hit: 1, capability_cache_hit: 1 },
  };
  const response = await callTargetTool(
    'target_diagnose',
    { target: 'test-host' },
    {
      capabilityInventory: {
        get: async () => inventoryResult(),
        snapshot: () => ({ entries: 1, pending: 0, ttl_ms: 120000, target_hashes: ['hidden'] }),
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
      telemetry: { snapshot: () => telemetrySnapshot },
      systemInfoImpl: async () => ({
        target: 'test-host',
        hostname: 'ubuntu-box',
        kernel: '7.0.0-29-generic',
        architecture: 'x86_64',
        os: { id: 'ubuntu', version: '26.04', pretty_name: 'Ubuntu 26.04' },
        uptime_seconds: 12345,
        raw: 'RAW_SYSTEM_TEXT_MUST_NOT_APPEAR',
        raw_truncated: false,
      }),
      diskUsageImpl: async () => ({
        filesystems: [
          { filesystem: '/dev/root', size_bytes: 1000, used_bytes: 500, available_bytes: 500, use_percent: 50, mountpoint: '/' },
        ],
      }),
      remoteExecImpl: async () => ({
        exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, truncated: false,
      }),
    },
  );

  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, {
    target: 'test-host',
    state: 'available',
    transport: {
      state: 'available',
      identity: inventoryResult().identity,
      multiplex: { mode: 'auto', state: 'active', active: true, target_hash: '0123456789abcdef' },
    },
    remote_identity: { state: 'available', user: 'tester', uid: 1000 },
    system: {
      state: 'available',
      hostname: 'ubuntu-box',
      kernel: '7.0.0-29-generic',
      architecture: 'x86_64',
      os: { id: 'ubuntu', version: '26.04', pretty_name: 'Ubuntu 26.04' },
      uptime_seconds: 12345,
    },
    privilege: {
      state: 'available',
      root_providers: inventoryResult().root_providers,
      cache: {
        state: 'available',
        ttl_ms: 120000,
        entries: 1,
        providers: { direct_root: 0, sudo_nopasswd: 1, docker_host_root: 0 },
      },
    },
    ai_tmux: { state: 'available', version: 'ai-tmux v0.11.7' },
    disk_pressure: { state: 'available', filesystem_count: 1, highest_use_percent: 50, root_use_percent: 50 },
    failed_systemd_units: { state: 'available', count: 0 },
    gpu: { state: 'not_applicable', provider: 'nvidia-smi', count: 0 },
    capabilities: inventoryResult().capabilities,
    capability_cache: { state: 'available', status: 'miss', ttl_ms: 120000, entries: 1, pending: 0 },
    telemetry: { state: 'available', ...telemetrySnapshot },
  });
  assert.equal(JSON.stringify(response).includes('RAW_SYSTEM_TEXT_MUST_NOT_APPEAR'), false);
  assert.equal(JSON.stringify(response).includes('hidden'), false);
});

test('target_diagnose distinguishes permission-limited privilege from unavailable privilege', async () => {
  for (const [providers, expected] of [
    [{ direct_root: false, sudo_nopasswd: false, docker_host_root: false, sudo_password: true, su_root_password: false }, 'permission_limited'],
    [{ direct_root: false, sudo_nopasswd: false, docker_host_root: false, sudo_password: false, su_root_password: false }, 'unavailable'],
  ]) {
    const inventory = { ...inventoryResult(), root_providers: providers };
    const response = await callTargetTool('target_diagnose', { target: 'test-host' }, {
      capabilityInventory: {
        get: async () => inventory,
        snapshot: () => ({ entries: 1, pending: 0, ttl_ms: 120000, target_hashes: [] }),
      },
      systemInfoImpl: async () => ({
        hostname: 'box', kernel: 'k', architecture: 'a',
        os: { id: 'ubuntu', version: '26.04', pretty_name: 'Ubuntu' }, uptime_seconds: 1,
      }),
      diskUsageImpl: async () => ({ filesystems: [] }),
      remoteExecImpl: async () => ({
        exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, truncated: false,
      }),
    });
    assert.equal(response.structuredContent.privilege.state, expected);
  }
});

test('target_diagnose keeps capability evidence when only system inspection fails', async () => {
  const response = await callTargetTool('target_diagnose', { target: 'test-host' }, {
    capabilityInventory: {
      get: async () => inventoryResult(),
      snapshot: () => ({ entries: 1, pending: 0, ttl_ms: 120000, target_hashes: [] }),
    },
    systemInfoImpl: async () => {
      throw new TerminalError('remote_command_nonzero_exit', 'uname failed');
    },
    diskUsageImpl: async () => ({ filesystems: [] }),
    remoteExecImpl: async () => ({
      exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, truncated: false,
    }),
  });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.state, 'degraded');
  assert.equal(response.structuredContent.transport.state, 'available');
  assert.equal(response.structuredContent.system.state, 'failure');
  assert.equal(response.structuredContent.system.failure.category, 'remote_command_nonzero_exit');
  assert.equal(response.structuredContent.capabilities.python3.available, true);
});

test('target_diagnose returns a bounded diagnostic failure instead of losing the transport failure as an MCP exception', async () => {
  const response = await callTargetTool('target_diagnose', { target: 'test-host' }, {
    capabilityInventory: {
      get: async () => {
        throw new TerminalError('transport_reconnect_failure', 'network reset', { retryable: true });
      },
    },
    telemetry: { snapshot: () => ({ timings: {}, counters: {} }) },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, {
    target: 'test-host',
    state: 'failure',
    transport: {
      state: 'failure',
      failure: { category: 'transport_reconnect_failure', message: 'network reset', retryable: true },
      multiplex: { mode: 'unmanaged', state: 'unavailable', active: false, target_hash: null },
    },
    remote_identity: { state: 'unavailable' },
    system: { state: 'unavailable' },
    privilege: {
      state: 'unavailable',
      root_providers: null,
      cache: {
        state: 'unavailable', ttl_ms: null, entries: null,
        providers: { direct_root: 0, sudo_nopasswd: 0, docker_host_root: 0 },
      },
    },
    ai_tmux: { state: 'unavailable', version: null },
    disk_pressure: {
      state: 'unavailable', filesystem_count: null, highest_use_percent: null, root_use_percent: null,
    },
    failed_systemd_units: { state: 'unavailable', count: null },
    gpu: { state: 'not_applicable', provider: 'nvidia-smi', count: 0 },
    capabilities: null,
    capability_cache: { state: 'unavailable', status: null, ttl_ms: null, entries: null, pending: null },
    telemetry: { state: 'available', timings: {}, counters: {} },
  });
});

