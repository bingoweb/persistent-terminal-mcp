import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SYSTEM_TOOLS,
  SYSTEM_TOOL_NAMES,
  callSystemTool,
} from '../src/system-tools.mjs';
import { LOCAL_TOOLS } from '../src/tool-registry.mjs';

function commandResult(overrides = {}) {
  return {
    exit_code: 0,
    stdout: '',
    stderr: '',
    duration_ms: 7,
    timed_out: false,
    truncated: false,
    ...overrides,
  };
}

const MUTATION_NAMES = ['process_signal', 'service_start', 'service_stop', 'service_restart'];

test('controlled mutation tools publish closed schemas with explicit privilege selection', () => {
  for (const name of MUTATION_NAMES) {
    const tool = SYSTEM_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.equal(SYSTEM_TOOL_NAMES.has(name), true);
    assert.equal(LOCAL_TOOLS.some((candidate) => candidate.name === name), true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.privilege, {
      type: 'string',
      enum: ['user', 'root'],
      default: 'user',
      description: 'Execution privilege is explicit; root uses best-effort root acquisition and is never selected automatically.',
    });
    assert.equal(tool.outputSchema.oneOf.length, 2);
  }
});

test('process_signal validates numeric PID and signal before executing anything', async () => {
  let remoteCalls = 0;
  let rootCalls = 0;
  const deps = {
    remoteExecImpl: async () => { remoteCalls += 1; return commandResult(); },
    rootExecImpl: async () => { rootCalls += 1; return commandResult(); },
  };

  for (const args of [
    { target: 'taylan', pid: '42', signal: 15 },
    { target: 'taylan', pid: 0, signal: 15 },
    { target: 'taylan', pid: 42, signal: '15' },
    { target: 'taylan', pid: 42, signal: 0 },
    { target: 'taylan', pid: 42, signal: 65 },
  ]) {
    const result = await callSystemTool('process_signal', args, deps);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.category, 'validation_error');
  }

  assert.equal(remoteCalls, 0);
  assert.equal(rootCalls, 0);
});

test('process_signal defaults to configured user execution and returns action/target/exit metadata', async () => {
  const calls = [];
  const result = await callSystemTool(
    'process_signal',
    { target: 'taylan', pid: 4242, signal: 15 },
    {
      remoteExecImpl: async (request) => {
        calls.push(structuredClone(request));
        return commandResult({ stdout: 'sent\n', duration_ms: 11 });
      },
      rootExecImpl: async () => { throw new Error('must not call root provider'); },
    },
  );

  assert.deepEqual(calls, [{
    target: 'taylan',
    command: 'kill -15 4242',
    env: { LC_ALL: 'C' },
    timeout_ms: 15_000,
    max_output_bytes: 65_536,
  }]);
  assert.deepEqual(result.structuredContent, {
    action: 'signal',
    target: 'taylan',
    privilege: 'user',
    strategy: null,
    pid: 4242,
    signal: 15,
    service: null,
    exit_code: 0,
    stdout: 'sent\n',
    stderr: '',
    duration_ms: 11,
    timed_out: false,
    truncated: false,
  });
});

test('user-mode permission failure is permission_privilege_error and never falls back to root', async () => {
  let rootCalls = 0;
  const result = await callSystemTool(
    'service_restart',
    { target: 'taylan', service: 'ssh.service' },
    {
      remoteExecImpl: async () => commandResult({
        exit_code: 1,
        stderr: 'Failed to restart ssh.service: Interactive authentication required.\n',
      }),
      rootExecImpl: async () => {
        rootCalls += 1;
        return commandResult();
      },
    },
  );

  assert.equal(rootCalls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    category: 'permission_privilege_error',
    message: 'service_restart requires privileges not available to the configured remote user',
    retryable: false,
    details: {
      action: 'restart',
      target: 'taylan',
      privilege: 'user',
      exit_code: 1,
      stderr: 'Failed to restart ssh.service: Interactive authentication required.\n',
    },
  });
});

test('explicit root process signal routes only to the best-effort root provider and stays visibly privileged', async () => {
  const rootCalls = [];
  const result = await callSystemTool(
    'process_signal',
    { target: 'taylan', pid: 4242, signal: 9, privilege: 'root' },
    {
      remoteExecImpl: async () => { throw new Error('must not call ordinary remote_exec'); },
      rootExecImpl: async (request) => {
        rootCalls.push(structuredClone(request));
        return {
          strategy: 'docker_host_root',
          target: 'taylan',
          ...commandResult({ duration_ms: 19 }),
        };
      },
    },
  );

  assert.deepEqual(rootCalls, [{ target: 'taylan', command: 'kill -9 4242' }]);
  assert.equal(result.structuredContent.privilege, 'root');
  assert.equal(result.structuredContent.strategy, 'docker_host_root');
  assert.equal(result.structuredContent.action, 'signal');
  assert.equal(result.structuredContent.exit_code, 0);
});

test('service mutation tools require exact .service names and user-mode command data stays out of shell source', async () => {
  const invalid = await callSystemTool(
    'service_start',
    { target: 'taylan', service: 'ssh.service; reboot' },
    { remoteExecImpl: async () => { throw new Error('must not execute invalid service'); } },
  );
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.category, 'validation_error');

  for (const [name, action] of [
    ['service_start', 'start'],
    ['service_stop', 'stop'],
    ['service_restart', 'restart'],
  ]) {
    const calls = [];
    const response = await callSystemTool(
      name,
      { target: 'taylan', service: 'ssh.service' },
      {
        remoteExecImpl: async (request) => {
          calls.push(structuredClone(request));
          return commandResult();
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.LC_ALL, 'C');
    assert.equal(calls[0].env.PTEXT_SERVICE, 'ssh.service');
    assert.equal(calls[0].command, `systemctl ${action} "$PTEXT_SERVICE"`);
    assert.equal(calls[0].command.includes('ssh.service'), false);
    assert.equal(response.structuredContent.action, action);
    assert.equal(response.structuredContent.service, 'ssh.service');
    assert.equal(response.structuredContent.target, 'taylan');
    assert.equal(response.structuredContent.exit_code, 0);
    assert.equal(response.structuredContent.privilege, 'user');
  }
});

test('explicit root service mutation uses only best-effort root provider with validated exact unit', async () => {
  const calls = [];
  const response = await callSystemTool(
    'service_restart',
    { target: 'taylan', service: 'ssh.service', privilege: 'root' },
    {
      remoteExecImpl: async () => { throw new Error('must not call user execution'); },
      rootExecImpl: async (request) => {
        calls.push(structuredClone(request));
        return {
          strategy: 'docker_host_root',
          target: 'taylan',
          ...commandResult(),
        };
      },
    },
  );

  assert.deepEqual(calls, [{ target: 'taylan', command: 'systemctl restart ssh.service' }]);
  assert.equal(response.structuredContent.action, 'restart');
  assert.equal(response.structuredContent.service, 'ssh.service');
  assert.equal(response.structuredContent.privilege, 'root');
  assert.equal(response.structuredContent.strategy, 'docker_host_root');
});

test('ordinary non-permission command failure remains an explicit exit result instead of escalating', async () => {
  let rootCalls = 0;
  const response = await callSystemTool(
    'process_signal',
    { target: 'taylan', pid: 999999, signal: 15 },
    {
      remoteExecImpl: async () => commandResult({
        exit_code: 1,
        stderr: 'kill: (999999): No such process\n',
      }),
      rootExecImpl: async () => { rootCalls += 1; return commandResult(); },
    },
  );

  assert.equal(rootCalls, 0);
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.exit_code, 1);
  assert.equal(response.structuredContent.stderr, 'kill: (999999): No such process\n');
  assert.equal(response.structuredContent.privilege, 'user');
});
