import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalError } from '../src/errors.mjs';
import {
  ADMIN_TRANSACTION_STATES,
  createAdminTransactionEngine,
  validateAdminTransactionRequest,
} from '../src/admin-transaction.mjs';

const BEFORE_SHA = 'a'.repeat(64);
const AFTER_SHA = 'b'.repeat(64);
const RESTORED_SHA = BEFORE_SHA;

function execResult(exitCode = 0, stdout = '', stderr = '') {
  return {
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: 2,
    timed_out: false,
    truncated: false,
  };
}

function fileRead(text = 'before\n', sha256 = BEFORE_SHA) {
  return { path: '/tmp/demo.conf', text, size: Buffer.byteLength(text), sha256 };
}

function baseDeps(overrides = {}) {
  return {
    remoteExecImpl: async () => execResult(),
    systemdActionImpl: async (request) => ({
      action: request.action,
      target: request.target,
      unit: request.unit,
      requested_privilege: request.privilege ?? 'auto',
      actual_privilege: 'root',
      strategy: 'docker_host_root',
      ...execResult(),
    }),
    systemdStatusImpl: async ({ target, unit }) => ({
      target, unit, names: [unit], description: 'demo', load_state: 'loaded',
      active_state: 'inactive', sub_state: 'dead', unit_file_state: 'disabled',
      main_pid: 0, result: null, raw: '', raw_truncated: false,
    }),
    remoteStatImpl: async () => ({ path: '/tmp/demo.conf', type: 'file', size: 7 }),
    remoteReadImpl: async () => fileRead(),
    remoteWriteImpl: async () => ({ path: '/tmp/demo.conf', created: false, size: 6, sha256: AFTER_SHA }),
    remotePatchImpl: async () => ({ path: '/tmp/demo.conf', size: 6, sha256: AFTER_SHA, hunks_applied: 1 }),
    randomIdImpl: () => 'tx_fixed_001',
    ...overrides,
  };
}

test('admin transaction state vocabulary is closed', () => {
  assert.deepEqual([...ADMIN_TRANSACTION_STATES], [
    'committed', 'precheck_failed', 'snapshot_failed', 'mutation_failed',
    'health_failed', 'rolled_back', 'rollback_failed',
  ]);
});

test('transaction validation rejects unbounded, binary, nested and non-reversible requests before dependencies are touched', () => {
  const valid = {
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'after\n' },
    health_checks: [{ type: 'command', command: 'true' }],
  };
  assert.equal(validateAdminTransactionRequest(valid).target, 'test-host');

  const invalid = [
    { ...valid, health_checks: [] },
    { ...valid, health_checks: Array.from({ length: 9 }, () => ({ type: 'command', command: 'true' })) },
    { ...valid, mutation: { type: 'shell', command: 'rm -rf /' } },
    { ...valid, mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'a\0b' } },
    { ...valid, mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'x'.repeat(1024 * 1024 + 1) } },
    { ...valid, mutation: { type: 'systemd_action', unit: 'demo.service', action: 'mask' } },
    { ...valid, health_checks: [{ type: 'command', command: 'true', stdout_regex: 'x'.repeat(257) }] },
    { ...valid, health_checks: [{ type: 'command', command: 'true', stdout_regex: '(a+)+$' }] },
    { ...valid, mutation: { type: 'remote_patch', path: '/tmp/demo.conf', hunks: [] } },
  ];
  for (const request of invalid) {
    assert.throws(() => validateAdminTransactionRequest(request), /transaction|health|mutation|rollback|regex|text|hunk/i);
  }
});

test('failed precheck returns precheck_failed without snapshot or mutation', async () => {
  let statCalls = 0;
  let writeCalls = 0;
  const engine = createAdminTransactionEngine(baseDeps({
    remoteExecImpl: async () => execResult(7, '', 'not ready\n'),
    remoteStatImpl: async () => { statCalls += 1; return { type: 'file', size: 7 }; },
    remoteWriteImpl: async () => { writeCalls += 1; return { sha256: AFTER_SHA }; },
  }));
  const result = await engine.execute({
    target: 'test-host',
    precheck: { command: 'test -f /ready' },
    mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'after\n' },
    health_checks: [{ type: 'command', command: 'true' }],
  });
  assert.equal(result.state, 'precheck_failed');
  assert.deepEqual(result.precheck, { configured: true, passed: false, exit_code: 7 });
  assert.equal(result.rollback.attempted, false);
  assert.equal(statCalls, 0);
  assert.equal(writeCalls, 0);
});

test('remote_write transaction commits after snapshot mutation and passing health without exposing file contents', async () => {
  const calls = [];
  const engine = createAdminTransactionEngine(baseDeps({
    remoteStatImpl: async (request) => { calls.push(['stat', structuredClone(request)]); return { path: request.path, type: 'file', size: 7 }; },
    remoteReadImpl: async (request) => { calls.push(['read', structuredClone(request)]); return fileRead(); },
    remoteWriteImpl: async (request) => { calls.push(['write', structuredClone(request)]); return { path: request.path, created: false, size: 6, sha256: AFTER_SHA }; },
    remoteExecImpl: async (request) => { calls.push(['health', structuredClone(request)]); return execResult(0, 'READY\n'); },
  }));

  const result = await engine.execute({
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'after\n' },
    health_checks: [{ type: 'command', command: 'check-health', stdout_regex: '^READY$' }],
  });
  assert.equal(result.state, 'committed');
  assert.deepEqual(result.mutation, {
    type: 'remote_write', path: '/tmp/demo.conf', before_sha256: BEFORE_SHA, after_sha256: AFTER_SHA,
  });
  assert.equal(result.health.passed, true);
  assert.equal(result.health.checks[0].stdout_regex_matched, true);
  assert.deepEqual(result.rollback, { attempted: false, succeeded: false, verified: false, failure: null });
  assert.equal(calls.find(([name]) => name === 'write')[1].expected_sha256, BEFORE_SHA, 'snapshot hash becomes optimistic write guard');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('before\n'), false);
  assert.equal(serialized.includes('after\n'), false);
  assert.equal(serialized.includes('READY'), false, 'health stdout must not be copied into result');
});

test('failed health restores original UTF-8 file with optimistic hash and verifies the restored SHA', async () => {
  let readCalls = 0;
  const writes = [];
  const engine = createAdminTransactionEngine(baseDeps({
    remoteReadImpl: async () => {
      readCalls += 1;
      if (readCalls === 1) return fileRead('before\n', BEFORE_SHA);
      return fileRead('before\n', RESTORED_SHA);
    },
    remoteWriteImpl: async (request) => {
      writes.push(structuredClone(request));
      if (writes.length === 1) return { path: request.path, created: false, size: 6, sha256: AFTER_SHA };
      return { path: request.path, created: false, size: 7, sha256: RESTORED_SHA };
    },
    remoteExecImpl: async () => execResult(2, '', 'health failed'),
  }));

  const result = await engine.execute({
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'after\n' },
    health_checks: [{ type: 'command', command: 'false' }],
  });
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.health.passed, false);
  assert.deepEqual(result.rollback, { attempted: true, succeeded: true, verified: true, failure: null });
  assert.equal(writes[0].expected_sha256, BEFORE_SHA);
  assert.equal(writes[1].expected_sha256, AFTER_SHA, 'rollback must refuse to overwrite a third-party change');
  assert.equal(writes[1].text, 'before\n');
  assert.equal(readCalls, 2, 'rollback is verified by a fresh read');
});

test('rollback checksum conflict is reported truthfully and never claimed successful', async () => {
  let writes = 0;
  const engine = createAdminTransactionEngine(baseDeps({
    remoteWriteImpl: async (request) => {
      writes += 1;
      if (writes === 1) return { path: request.path, created: false, size: 6, sha256: AFTER_SHA };
      throw new TerminalError('checksum_integrity_failure', 'file changed outside transaction');
    },
    remoteExecImpl: async () => execResult(1),
  }));
  const result = await engine.execute({
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'after\n' },
    health_checks: [{ type: 'command', command: 'false' }],
  });
  assert.equal(result.state, 'rollback_failed');
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.succeeded, false);
  assert.equal(result.rollback.verified, false);
  assert.equal(result.rollback.failure.category, 'checksum_integrity_failure');
});

test('remote_patch uses snapshot hash by default and rolls back through atomic write', async () => {
  const patches = [];
  const writes = [];
  let reads = 0;
  const engine = createAdminTransactionEngine(baseDeps({
    remotePatchImpl: async (request) => {
      patches.push(structuredClone(request));
      return { path: request.path, size: 7, sha256: AFTER_SHA, hunks_applied: 1 };
    },
    remoteWriteImpl: async (request) => { writes.push(structuredClone(request)); return { path: request.path, created: false, size: 7, sha256: BEFORE_SHA }; },
    remoteReadImpl: async () => { reads += 1; return fileRead('before\n', BEFORE_SHA); },
    remoteExecImpl: async () => execResult(1),
  }));
  const result = await engine.execute({
    target: 'test-host',
    mutation: {
      type: 'remote_patch', path: '/tmp/demo.conf',
      hunks: [{ old: 'before', new: 'after', expected_count: 1 }],
    },
    health_checks: [{ type: 'command', command: 'false' }],
  });
  assert.equal(result.state, 'rolled_back');
  assert.equal(patches[0].expected_sha256, BEFORE_SHA);
  assert.equal(writes[0].expected_sha256, AFTER_SHA);
  assert.equal(reads, 2);
});

test('systemd start transaction rolls back to pre-transaction inactive state and verifies it', async () => {
  const actions = [];
  let statusCalls = 0;
  const engine = createAdminTransactionEngine(baseDeps({
    systemdStatusImpl: async ({ target, unit }) => {
      statusCalls += 1;
      return {
        target, unit, active_state: statusCalls === 1 ? 'inactive' : 'inactive',
        sub_state: 'dead', unit_file_state: 'disabled',
      };
    },
    systemdActionImpl: async (request) => {
      actions.push(structuredClone(request));
      return {
        action: request.action, target: request.target, unit: request.unit,
        requested_privilege: request.privilege, actual_privilege: 'root', strategy: 'docker_host_root',
        ...execResult(),
      };
    },
    remoteExecImpl: async () => execResult(1),
  }));

  const result = await engine.execute({
    target: 'test-host', privilege: 'auto',
    mutation: { type: 'systemd_action', unit: 'demo.service', action: 'start' },
    health_checks: [{ type: 'command', command: 'false' }],
  });
  assert.equal(result.state, 'rolled_back');
  assert.deepEqual(actions.map(({ action }) => action), ['start', 'stop']);
  assert.equal(actions[1].privilege, 'auto');
  assert.equal(statusCalls, 2);
  assert.equal(result.rollback.verified, true);
});

test('systemd health checks compare exact requested states without exposing raw status text', async () => {
  const engine = createAdminTransactionEngine(baseDeps({
    systemdStatusImpl: async ({ target, unit }) => ({
      target, unit, active_state: 'active', sub_state: 'running', unit_file_state: 'enabled', raw: 'SECRET_RAW',
    }),
  }));
  const result = await engine.execute({
    target: 'test-host',
    mutation: { type: 'systemd_action', unit: 'demo.service', action: 'start' },
    health_checks: [{ type: 'systemd_unit', unit: 'demo.service', active_state: 'active', sub_state: 'running' }],
  });
  assert.equal(result.state, 'committed');
  assert.deepEqual(result.health.checks[0], {
    type: 'systemd_unit', unit: 'demo.service', passed: true, active_state: 'active', sub_state: 'running',
  });
  assert.equal(JSON.stringify(result).includes('SECRET_RAW'), false);
});

test('health transport failure triggers rollback but mutation transport failure is not replayed or guessed', async () => {
  let writes = 0;
  let healthCalls = 0;
  const rollbackEngine = createAdminTransactionEngine(baseDeps({
    remoteWriteImpl: async (request) => {
      writes += 1;
      return { path: request.path, created: false, size: 7, sha256: writes === 1 ? AFTER_SHA : BEFORE_SHA };
    },
    remoteReadImpl: async () => fileRead('before\n', BEFORE_SHA),
    remoteExecImpl: async () => {
      healthCalls += 1;
      throw new TerminalError('transport_reconnect_failure', 'health link lost', { retryable: true });
    },
  }));
  const rolledBack = await rollbackEngine.execute({
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'after\n' },
    health_checks: [{ type: 'command', command: 'health' }],
  });
  assert.equal(healthCalls, 1);
  assert.equal(rolledBack.state, 'rolled_back');
  assert.equal(rolledBack.health.checks[0].failure.category, 'transport_reconnect_failure');

  let mutationCalls = 0;
  const mutationFailure = createAdminTransactionEngine(baseDeps({
    remoteWriteImpl: async () => {
      mutationCalls += 1;
      throw new TerminalError('transport_reconnect_failure', 'write response lost', { retryable: true });
    },
  }));
  const failed = await mutationFailure.execute({
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo.conf', text: 'after\n' },
    health_checks: [{ type: 'command', command: 'true' }],
  });
  assert.equal(mutationCalls, 1);
  assert.equal(failed.state, 'mutation_failed');
  assert.equal(failed.rollback.attempted, false, 'ambiguous mutation outcome must not trigger guessed rollback');
});

