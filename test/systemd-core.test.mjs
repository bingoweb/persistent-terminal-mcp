import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SYSTEMD_ACTIONS,
  SYSTEMD_UNIT_TYPES,
  parseSystemdDependenciesOutput,
  parseSystemdListOutput,
  parseSystemdStatusOutput,
  systemdUnitDependencies,
  systemdUnitList,
  systemdUnitAction,
  systemdDaemonReload,
  systemdUnitStatus,
  validateSystemdAction,
  validateSystemdUnit,
  validateSystemdUnitType,
} from '../src/systemd-core.mjs';

function remoteResult(stdout, overrides = {}) {
  return {
    exit_code: 0,
    stdout,
    stderr: '',
    duration_ms: 3,
    timed_out: false,
    truncated: false,
    ...overrides,
  };
}

test('systemd unit validator accepts every supported exact suffix and rejects unsafe or unsupported names', () => {
  assert.deepEqual([...SYSTEMD_UNIT_TYPES], [
    'service', 'socket', 'timer', 'path', 'mount', 'automount', 'target', 'slice', 'scope',
  ]);
  for (const unit of [
    'ssh.service', 'docker.socket', 'apt-daily.timer', 'watch.path', 'srv-data.mount',
    'srv-data.automount', 'multi-user.target', 'user-1000.slice', 'session-42.scope',
    'templated@blue.service',
  ]) {
    assert.equal(validateSystemdUnit(unit), unit);
  }
  for (const unit of [
    '', 'ssh', 'ssh.service;reboot', 'ssh service', '../ssh.service', '/ssh.service',
    'x.device', 'x.swap', 'x.preset', 'x.service\0bad',
  ]) {
    assert.throws(() => validateSystemdUnit(unit), /exact systemd unit|supported suffix/i);
  }
});

test('systemd unit validator and list parser accept canonical systemd hex escapes without accepting arbitrary backslashes', () => {
  const escapedUnit = String.raw`systemd-fsck@dev-disk-by\x2duuid-20C2\x2dF69E.service`;
  assert.equal(validateSystemdUnit(escapedUnit), escapedUnit);
  assert.deepEqual(parseSystemdListOutput(`${escapedUnit} loaded inactive dead File System Check\n`), [
    {
      unit: escapedUnit,
      load_state: 'loaded',
      active_state: 'inactive',
      sub_state: 'dead',
      description: 'File System Check',
    },
  ]);
  for (const invalid of [
    String.raw`bad\escape.service`,
    String.raw`bad\xZZ.service`,
    String.raw`bad\x2.service`,
  ]) {
    assert.throws(() => validateSystemdUnit(invalid), /exact systemd unit|supported suffix/i);
  }
});

test('systemd unit type validator accepts closed list only', () => {
  assert.equal(validateSystemdUnitType(undefined), null);
  assert.equal(validateSystemdUnitType('timer'), 'timer');
  assert.throws(() => validateSystemdUnitType('device'), /systemd unit type/i);
  assert.throws(() => validateSystemdUnitType('timer socket'), /systemd unit type/i);
});

test('status parser normalizes service socket timer and mount properties without assuming service-only fields', () => {
  for (const fixture of [
    {
      text: [
        'Id=ssh.service', 'Names=ssh.service sshd.service', 'Description=OpenSSH server daemon',
        'LoadState=loaded', 'ActiveState=active', 'SubState=running', 'UnitFileState=enabled',
        'MainPID=917', 'Result=success', '',
      ].join('\n'),
      expected: { unit: 'ssh.service', main_pid: 917, active_state: 'active', unit_file_state: 'enabled' },
    },
    {
      text: [
        'Id=docker.socket', 'Names=docker.socket', 'Description=Docker Socket', 'LoadState=loaded',
        'ActiveState=active', 'SubState=listening', 'UnitFileState=enabled', 'MainPID=0', 'Result=', '',
      ].join('\n'),
      expected: { unit: 'docker.socket', main_pid: 0, active_state: 'active', unit_file_state: 'enabled' },
    },
    {
      text: [
        'Id=apt-daily.timer', 'Names=apt-daily.timer', 'Description=Daily apt download activities',
        'LoadState=loaded', 'ActiveState=active', 'SubState=waiting', 'UnitFileState=static',
        'MainPID=0', 'Result=', '',
      ].join('\n'),
      expected: { unit: 'apt-daily.timer', main_pid: 0, active_state: 'active', unit_file_state: 'static' },
    },
    {
      text: [
        'Id=srv-data.mount', 'Names=srv-data.mount', 'Description=/srv/data', 'LoadState=loaded',
        'ActiveState=inactive', 'SubState=dead', 'UnitFileState=', 'MainPID=0', 'Result=', '',
      ].join('\n'),
      expected: { unit: 'srv-data.mount', main_pid: 0, active_state: 'inactive', unit_file_state: null },
    },
  ]) {
    const parsed = parseSystemdStatusOutput(fixture.text);
    assert.equal(parsed.unit, fixture.expected.unit);
    assert.equal(parsed.main_pid, fixture.expected.main_pid);
    assert.equal(parsed.active_state, fixture.expected.active_state);
    assert.equal(parsed.unit_file_state, fixture.expected.unit_file_state);
  }

  const parsed = parseSystemdStatusOutput([
    'Id=ssh.service', 'Names=ssh.service sshd.service', 'Description=OpenSSH server daemon',
    'LoadState=loaded', 'ActiveState=active', 'SubState=running', 'UnitFileState=enabled',
    'MainPID=917', 'Result=success', '',
  ].join('\n'));
  assert.deepEqual(parsed.names, ['ssh.service', 'sshd.service']);
  assert.equal(parsed.description, 'OpenSSH server daemon');
  assert.equal(parsed.result, 'success');
});

test('systemd_unit_status carries the exact unit through structured env and rejects malformed execution', async () => {
  const calls = [];
  const fixture = [
    'Id=docker.socket', 'Names=docker.socket', 'Description=Docker Socket', 'LoadState=loaded',
    'ActiveState=active', 'SubState=listening', 'UnitFileState=enabled', 'MainPID=0', 'Result=', '',
  ].join('\n');
  const result = await systemdUnitStatus(
    { target: 'taylan', unit: 'docker.socket' },
    { remoteExecImpl: async (request) => { calls.push(structuredClone(request)); return remoteResult(fixture); } },
  );
  assert.equal(result.target, 'taylan');
  assert.equal(result.unit, 'docker.socket');
  assert.equal(calls[0].env.PTEXT_UNIT, 'docker.socket');
  assert.equal(calls[0].env.LC_ALL, 'C');
  assert.equal(calls[0].command.includes('docker.socket'), false);
  assert.match(calls[0].command, /\$PTEXT_UNIT/u);

  await assert.rejects(
    systemdUnitStatus(
      { target: 'taylan', unit: 'docker.socket' },
      { remoteExecImpl: async () => remoteResult('', { exit_code: 1, stderr: 'Unit not found' }) },
    ),
    (error) => error?.category === 'remote_command_nonzero_exit' && /Unit not found/.test(error.message),
  );
});

test('list parser handles failed-unit bullet, descriptions with spaces and bounded truncation', async () => {
  const fixture = [
    'ssh.service loaded active running OpenSSH server daemon',
    '● broken.service loaded failed failed Broken disposable service',
    'docker.socket loaded active listening Docker Socket for the API',
    '',
  ].join('\n');
  assert.deepEqual(parseSystemdListOutput(fixture), [
    { unit: 'ssh.service', load_state: 'loaded', active_state: 'active', sub_state: 'running', description: 'OpenSSH server daemon' },
    { unit: 'broken.service', load_state: 'loaded', active_state: 'failed', sub_state: 'failed', description: 'Broken disposable service' },
    { unit: 'docker.socket', load_state: 'loaded', active_state: 'active', sub_state: 'listening', description: 'Docker Socket for the API' },
  ]);

  const calls = [];
  const result = await systemdUnitList(
    { target: 'taylan', type: 'service', limit: 2 },
    { remoteExecImpl: async (request) => { calls.push(structuredClone(request)); return remoteResult(fixture); } },
  );
  assert.equal(calls[0].env.PTEXT_TYPE, 'service');
  assert.equal(calls[0].env.PTEXT_LIMIT_PLUS_ONE, '3');
  assert.equal(calls[0].command.includes('service'), false);
  assert.match(calls[0].command, /\$PTEXT_TYPE/u);
  assert.equal(result.units.length, 2);
  assert.equal(result.results_truncated, true);
});

test('dependency parser returns deterministic unique arrays and dependency helper uses fixed show properties', async () => {
  const fixture = [
    'Requires=system.slice basic.target',
    'Wants=network-online.target basic.target',
    'Before=shutdown.target multi-user.target',
    'After=network.target basic.target network.target',
    'Conflicts=shutdown.target',
    '',
  ].join('\n');
  assert.deepEqual(parseSystemdDependenciesOutput(fixture), {
    requires: ['basic.target', 'system.slice'],
    wants: ['basic.target', 'network-online.target'],
    before: ['multi-user.target', 'shutdown.target'],
    after: ['basic.target', 'network.target'],
    conflicts: ['shutdown.target'],
  });

  const calls = [];
  const result = await systemdUnitDependencies(
    { target: 'taylan', unit: 'ssh.service' },
    { remoteExecImpl: async (request) => { calls.push(structuredClone(request)); return remoteResult(fixture); } },
  );
  assert.equal(result.unit, 'ssh.service');
  assert.equal(calls[0].env.PTEXT_UNIT, 'ssh.service');
  assert.equal(calls[0].command.includes('ssh.service'), false);
  assert.match(calls[0].command, /--property=Requires/u);
});

test('systemd action vocabulary is closed and maps only validated exact actions', () => {
  assert.deepEqual([...SYSTEMD_ACTIONS], [
    'start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart',
    'enable', 'disable', 'reenable', 'mask', 'unmask', 'reset-failed',
  ]);
  for (const action of SYSTEMD_ACTIONS) assert.equal(validateSystemdAction(action), action);
  for (const action of ['', 'daemon-reload', 'restart; reboot', 'cat', 'start stop']) {
    assert.throws(() => validateSystemdAction(action), /systemd action/i);
  }
});

test('systemd unit action auto mode stays user when execution succeeds and keeps action/unit in structured env', async () => {
  const calls = [];
  const result = await systemdUnitAction(
    { target: 'taylan', unit: 'demo.timer', action: 'restart' },
    {
      remoteExecImpl: async (request) => { calls.push(structuredClone(request)); return remoteResult(''); },
      rootExecImpl: async () => { throw new Error('must not escalate'); },
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].env, { LC_ALL: 'C', PTEXT_ACTION: 'restart', PTEXT_UNIT: 'demo.timer' });
  assert.equal(calls[0].command, 'systemctl --no-ask-password "$PTEXT_ACTION" "$PTEXT_UNIT"');
  assert.equal(calls[0].command.includes('demo.timer'), false);
  assert.deepEqual(result, {
    action: 'restart', target: 'taylan', unit: 'demo.timer',
    requested_privilege: 'auto', actual_privilege: 'user', strategy: null,
    exit_code: 0, stdout: '', stderr: '', duration_ms: 3, timed_out: false, truncated: false,
  });
});

test('systemd unit action auto mode escalates exactly once only on classified privilege denial', async () => {
  const rootCalls = [];
  const result = await systemdUnitAction(
    { target: 'taylan', unit: 'demo.socket', action: 'start', privilege: 'auto' },
    {
      remoteExecImpl: async () => remoteResult('', {
        exit_code: 1,
        stderr: 'Failed to start demo.socket: Interactive authentication required.\n',
      }),
      rootExecImpl: async (request) => {
        rootCalls.push(structuredClone(request));
        return {
          strategy: 'docker_host_root', target: 'taylan',
          ...remoteResult('started\n', { duration_ms: 9 }),
        };
      },
    },
  );
  assert.equal(rootCalls.length, 1);
  assert.match(rootCalls[0].command, /systemctl --no-ask-password/);
  assert.match(rootCalls[0].command, /demo\.socket/);
  assert.match(rootCalls[0].command, /start/);
  assert.equal(result.requested_privilege, 'auto');
  assert.equal(result.actual_privilege, 'root');
  assert.equal(result.strategy, 'docker_host_root');
  assert.equal(result.stdout, 'started\n');
});

test('systemd unit action does not escalate ordinary missing-unit or application failures', async () => {
  let rootCalls = 0;
  const result = await systemdUnitAction(
    { target: 'taylan', unit: 'missing.service', action: 'restart' },
    {
      remoteExecImpl: async () => remoteResult('', {
        exit_code: 5,
        stderr: 'Failed to restart missing.service: Unit missing.service not found.\n',
      }),
      rootExecImpl: async () => { rootCalls += 1; return remoteResult(''); },
    },
  );
  assert.equal(rootCalls, 0);
  assert.equal(result.actual_privilege, 'user');
  assert.equal(result.exit_code, 5);
  assert.match(result.stderr, /Unit missing\.service not found/);
});

test('systemd unit action user forbids escalation while root starts through the root provider', async () => {
  let rootCalls = 0;
  await assert.rejects(
    systemdUnitAction(
      { target: 'taylan', unit: 'demo.service', action: 'stop', privilege: 'user' },
      {
        remoteExecImpl: async () => remoteResult('', { exit_code: 1, stderr: 'Access denied\n' }),
        rootExecImpl: async () => { rootCalls += 1; return remoteResult(''); },
      },
    ),
    (error) => error?.category === 'permission_privilege_error',
  );
  assert.equal(rootCalls, 0);

  const calls = [];
  const rooted = await systemdUnitAction(
    { target: 'taylan', unit: 'demo.service', action: 'stop', privilege: 'root' },
    {
      remoteExecImpl: async () => { throw new Error('must not use user mode'); },
      rootExecImpl: async (request) => {
        calls.push(structuredClone(request));
        return { strategy: 'sudo_nopasswd', target: 'taylan', ...remoteResult('') };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(rooted.actual_privilege, 'root');
  assert.equal(rooted.strategy, 'sudo_nopasswd');
});

test('systemd daemon reload defaults to root but supports strict user and auto modes', async () => {
  const rootCalls = [];
  const rooted = await systemdDaemonReload(
    { target: 'taylan' },
    {
      remoteExecImpl: async () => { throw new Error('default must not try user'); },
      rootExecImpl: async (request) => {
        rootCalls.push(structuredClone(request));
        return { strategy: 'docker_host_root', target: 'taylan', ...remoteResult('') };
      },
    },
  );
  assert.deepEqual(rootCalls, [{ target: 'taylan', command: 'systemctl --no-ask-password daemon-reload' }]);
  assert.equal(rooted.requested_privilege, 'root');
  assert.equal(rooted.actual_privilege, 'root');

  const userCalls = [];
  const user = await systemdDaemonReload(
    { target: 'taylan', privilege: 'user' },
    {
      remoteExecImpl: async (request) => { userCalls.push(structuredClone(request)); return remoteResult(''); },
      rootExecImpl: async () => { throw new Error('strict user must not escalate'); },
    },
  );
  assert.equal(userCalls[0].command, 'systemctl --no-ask-password daemon-reload');
  assert.equal(user.actual_privilege, 'user');
});

