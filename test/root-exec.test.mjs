import assert from 'node:assert/strict';
import test from 'node:test';

import { readDockerRootTargets, readRootTargets } from '../src/config.mjs';
import { remoteRootExec } from '../src/root-exec.mjs';

function commandResult(overrides = {}) {
  return {
    exit_code: 0,
    stdout: '',
    stderr: '',
    duration_ms: 4,
    timed_out: false,
    truncated: false,
    ...overrides,
  };
}

function toolResult(value, { isError = false } = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

test('root target allowlist is explicit and preserves the legacy Docker target setting as fallback', () => {
  assert.deepEqual([...readDockerRootTargets({})], []);
  assert.deepEqual([...readRootTargets({})], []);
  assert.deepEqual(
    [...readRootTargets({ PTEXT_DOCKER_ROOT_TARGETS: ' taylan, staging ,,taylan ' })],
    ['taylan', 'staging'],
  );
  assert.deepEqual(
    [...readRootTargets({
      PTEXT_ROOT_TARGETS: 'taylan,lab',
      PTEXT_DOCKER_ROOT_TARGETS: 'legacy-only',
    })],
    ['taylan', 'lab'],
  );
});

test('already-root SSH user is selected immediately and no escalation provider is touched', async () => {
  const calls = [];
  const result = await remoteRootExec(
    { target: 'taylan', command: 'id -u' },
    {
      env: { PTEXT_ROOT_TARGETS: 'taylan' },
      remoteExecImpl: async (request) => {
        calls.push(structuredClone(request));
        if (calls.length === 1) return commandResult({ stdout: '0\n' });
        return commandResult({ stdout: '0\n', duration_ms: 8 });
      },
      upstreamClient: { callTool: async () => { throw new Error('must not use PTY'); } },
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'id -u');
  assert.equal(calls[1].command, 'id -u');
  assert.equal(result.strategy, 'direct_root');
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.attempts, [{ strategy: 'direct_root', status: 'selected' }]);
});

test('passwordless sudo is preferred before Docker and executes the requested command only after capability proof', async () => {
  const calls = [];
  const result = await remoteRootExec(
    { target: 'taylan', command: "printf '%s\\n' \"$(id -u)\"" },
    {
      env: { PTEXT_ROOT_TARGETS: 'taylan' },
      remoteExecImpl: async (request) => {
        calls.push(structuredClone(request));
        if (calls.length === 1) return commandResult({ stdout: '1000\n' });
        if (calls.length === 2) return commandResult(); // command -v sudo
        if (calls.length === 3) return commandResult(); // sudo -n true
        return commandResult({ stdout: '0\n', duration_ms: 13 });
      },
    },
  );

  assert.equal(calls.length, 4);
  assert.equal(calls[1].command, 'command -v sudo >/dev/null 2>&1');
  assert.equal(calls[2].command, 'sudo -n -- /bin/bash -lc true');
  assert.match(calls[3].command, /^sudo -n -- \/bin\/bash -lc /u);
  assert.equal(calls.some((call) => call.command.includes('docker run')), false);
  assert.equal(result.strategy, 'sudo_nopasswd');
  assert.deepEqual(result.attempts, [
    { strategy: 'direct_root', status: 'unavailable' },
    { strategy: 'sudo_nopasswd', status: 'selected' },
  ]);
});

test('Docker host-root is tried after passwordless sudo is unavailable and only selected after a UID 0 capability proof', async () => {
  const calls = [];
  const result = await remoteRootExec(
    { target: 'taylan', command: 'id -u', timeout_ms: 12_000, max_output_bytes: 65_536 },
    {
      env: { PTEXT_ROOT_TARGETS: 'taylan' },
      remoteExecImpl: async (request) => {
        calls.push(structuredClone(request));
        if (calls.length === 1) return commandResult({ stdout: '1000\n' });
        if (calls.length === 2) return commandResult(); // sudo exists
        if (calls.length === 3) return commandResult({ exit_code: 1, stderr: 'sudo: a password is required\n' });
        if (calls.length === 4) return commandResult(); // docker exists
        if (calls.length === 5) return commandResult({ stdout: '0\n' }); // docker root proof
        return commandResult({ stdout: '0\n', duration_ms: 27 });
      },
    },
  );

  assert.equal(calls[3].command, 'command -v docker >/dev/null 2>&1');
  assert.match(calls[4].command, /docker run --rm --privileged --pid=host --net=host -v \/:\/host ubuntu:26\.04 chroot \/host \/bin\/bash -lc 'id -u'/u);
  assert.match(calls[5].command, /docker run --rm --privileged/u);
  assert.equal(result.strategy, 'docker_host_root');
  assert.deepEqual(result.attempts, [
    { strategy: 'direct_root', status: 'unavailable' },
    { strategy: 'sudo_nopasswd', status: 'unavailable' },
    { strategy: 'docker_host_root', status: 'selected' },
  ]);
});

test('when automatic providers fail, interactive sudo opens the secret-safe GUI only after PTY reports a password prompt', async () => {
  const execCalls = [];
  const upstreamCalls = [];
  const upstreamClient = {
    async callTool(name, args) {
      upstreamCalls.push({ name, args: structuredClone(args) });
      if (name === 'create_ssh_session') return toolResult({ session_id: 'sess-root-1' });
      if (name === 'get_session_state') {
        const count = upstreamCalls.filter((call) => call.name === 'get_session_state').length;
        return toolResult(count === 1
          ? { session_id: 'sess-root-1', cursor: 10, is_alive: true, awaiting_secret: false, state: 'at_prompt' }
          : { session_id: 'sess-root-1', cursor: 80, is_alive: true, awaiting_secret: true, state: 'password_prompt' });
      }
      if (name === 'send_input') return toolResult({ cursor_start: 10, cursor_end: 80, is_complete: false });
      if (name === 'read_output' && args.wait_for) {
        const waitCount = upstreamCalls.filter((call) => call.name === 'read_output' && call.args.wait_for).length;
        if (waitCount === 1) return toolResult({ matched: true, match_line: '__PTEXT_ROOT_PASSWORD_deadbeef__', cursor: 80, is_alive: true });
        return toolResult({ matched: true, match_line: '__PTEXT_ROOT_OUTER_deadbeef__0', cursor: 180, is_alive: true });
      }
      if (name === 'send_secret') return toolResult({ sent: true });
      if (name === 'read_output' && args.since_cursor === 10) {
        return toolResult({
          output: [
            'sudo command echo',
            '__PTEXT_ROOT_PASSWORD_deadbeef__',
            '__PTEXT_ROOT_START_deadbeef__',
            '0',
            '__PTEXT_ROOT_END_deadbeef__0',
            '__PTEXT_ROOT_OUTER_deadbeef__0',
            '',
          ].join('\n'),
          cursor: 180,
          has_more: false,
          is_truncated: false,
          is_alive: true,
        });
      }
      if (name === 'close_session') return toolResult({ closed: true });
      throw new Error(`unexpected upstream call ${name}: ${JSON.stringify(args)}`);
    },
  };

  const result = await remoteRootExec(
    { target: 'taylan', command: 'id -u' },
    {
      env: { PTEXT_ROOT_TARGETS: 'taylan' },
      randomTokenImpl: () => 'deadbeef',
      resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
      upstreamClient,
      remoteExecImpl: async (request) => {
        execCalls.push(structuredClone(request));
        if (execCalls.length === 1) return commandResult({ stdout: '1000\n' });
        if (execCalls.length === 2) return commandResult(); // sudo exists
        if (execCalls.length === 3) return commandResult({ exit_code: 1, stderr: 'sudo: a password is required\n' });
        if (execCalls.length === 4) return commandResult({ exit_code: 1 }); // docker absent
        throw new Error(`unexpected exec call ${JSON.stringify(request)}`);
      },
    },
  );

  const secretIndex = upstreamCalls.findIndex((call) => call.name === 'send_secret');
  const promptStateIndex = upstreamCalls.findIndex(
    (call, index) => call.name === 'get_session_state'
      && index > 0
      && call.args.session_id === 'sess-root-1',
  );
  assert.ok(secretIndex > promptStateIndex);
  assert.deepEqual(upstreamCalls[secretIndex], {
    name: 'send_secret',
    args: {
      session_id: 'sess-root-1',
      prompt: 'Enter sudo password for taylan:',
    },
  });
  assert.equal(JSON.stringify(upstreamCalls).includes('password123'), false);
  assert.equal(result.strategy, 'sudo_password');
  assert.equal(result.stdout, '0');
  assert.equal(result.exit_code, 0);
  assert.equal(upstreamCalls.at(-1).name, 'close_session');
  assert.deepEqual(result.attempts, [
    { strategy: 'direct_root', status: 'unavailable' },
    { strategy: 'sudo_nopasswd', status: 'unavailable' },
    { strategy: 'docker_host_root', status: 'unavailable' },
    { strategy: 'sudo_password', status: 'selected' },
  ]);
});

test('when sudo is unavailable, su fallback can open a secret-safe root-password GUI and select su_root_password', async () => {
  const execCalls = [];
  const upstreamCalls = [];
  const upstreamClient = {
    async callTool(name, args) {
      upstreamCalls.push({ name, args: structuredClone(args) });
      if (name === 'create_ssh_session') return toolResult({ session_id: 'sess-su-root' });
      if (name === 'get_session_state') {
        const count = upstreamCalls.filter((call) => call.name === 'get_session_state').length;
        return toolResult(count === 1
          ? { session_id: 'sess-su-root', cursor: 5, is_alive: true, awaiting_secret: false, state: 'at_prompt' }
          : { session_id: 'sess-su-root', cursor: 30, is_alive: true, awaiting_secret: true, state: 'password_prompt' });
      }
      if (name === 'send_input') return toolResult({ cursor_start: 5, cursor_end: 30, is_complete: false });
      if (name === 'read_output' && args.wait_for) {
        const waits = upstreamCalls.filter((call) => call.name === 'read_output' && call.args.wait_for).length;
        if (waits === 1) return toolResult({ matched: true, match_line: 'Password:', cursor: 30, is_alive: true });
        return toolResult({ matched: true, match_line: '__PTEXT_ROOT_OUTER_feedface__0', cursor: 90, is_alive: true });
      }
      if (name === 'send_secret') return toolResult({ sent: true });
      if (name === 'read_output' && args.since_cursor === 5) {
        return toolResult({
          output: [
            'Password:',
            '__PTEXT_ROOT_START_feedface__',
            '0',
            '__PTEXT_ROOT_END_feedface__0',
            '__PTEXT_ROOT_OUTER_feedface__0',
            '',
          ].join('\n'),
          cursor: 90,
          has_more: false,
          is_truncated: false,
          is_alive: true,
        });
      }
      if (name === 'close_session') return toolResult({ closed: true });
      throw new Error(`unexpected upstream call ${name}: ${JSON.stringify(args)}`);
    },
  };

  const result = await remoteRootExec(
    { target: 'taylan', command: 'id -u' },
    {
      env: { PTEXT_ROOT_TARGETS: 'taylan' },
      randomTokenImpl: () => 'feedface',
      resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
      upstreamClient,
      remoteExecImpl: async (request) => {
        execCalls.push(structuredClone(request));
        if (request.command === 'id -u') return commandResult({ stdout: '1000\n' });
        if (request.command === 'command -v sudo >/dev/null 2>&1') return commandResult({ exit_code: 1 });
        if (request.command === 'command -v docker >/dev/null 2>&1') return commandResult({ exit_code: 1 });
        if (request.command === 'command -v su >/dev/null 2>&1') return commandResult();
        throw new Error(`unexpected exec call ${JSON.stringify(request)}`);
      },
    },
  );

  assert.equal(result.strategy, 'su_root_password');
  assert.equal(result.stdout, '0');
  assert.equal(result.exit_code, 0);
  assert.deepEqual(
    upstreamCalls.find((call) => call.name === 'send_secret'),
    {
      name: 'send_secret',
      args: {
        session_id: 'sess-su-root',
        prompt: 'Enter root password for taylan:',
      },
    },
  );
  assert.equal(upstreamCalls.at(-1).name, 'close_session');
  assert.deepEqual(result.attempts, [
    { strategy: 'direct_root', status: 'unavailable' },
    { strategy: 'sudo_nopasswd', status: 'unavailable' },
    { strategy: 'docker_host_root', status: 'unavailable' },
    { strategy: 'su_root_password', status: 'selected' },
  ]);
});

test('unknown target is denied before any root probe or password prompt', async () => {
  let execCalls = 0;
  let upstreamCalls = 0;
  await assert.rejects(
    remoteRootExec(
      { target: 'other-host', command: 'id -u' },
      {
        env: { PTEXT_ROOT_TARGETS: 'taylan' },
        remoteExecImpl: async () => { execCalls += 1; return commandResult(); },
        upstreamClient: { callTool: async () => { upstreamCalls += 1; return toolResult({}); } },
      },
    ),
    (error) => error?.category === 'permission_privilege_error' && /not allowlisted/i.test(error.message),
  );
  assert.equal(execCalls, 0);
  assert.equal(upstreamCalls, 0);
});

test('all root acquisition methods failing returns one auditable privilege error without exposing secrets', async () => {
  const upstreamClient = {
    async callTool(name, args) {
      if (name === 'create_ssh_session') return toolResult({ session_id: 'sess-fail' });
      if (name === 'get_session_state') return toolResult({ cursor: 0, is_alive: true, awaiting_secret: false, state: 'at_prompt' });
      if (name === 'send_input') return toolResult({ cursor_start: 0, cursor_end: 20, is_complete: true });
      if (name === 'read_output' && args.wait_for) return toolResult({ matched: true, match_line: '__PTEXT_ROOT_OUTER_deadbeef__1', cursor: 40, is_alive: true });
      if (name === 'read_output' && args.since_cursor === 0) return toolResult({ output: '__PTEXT_ROOT_OUTER_deadbeef__1\n', cursor: 40, has_more: false, is_truncated: false, is_alive: true });
      if (name === 'close_session') return toolResult({ closed: true });
      throw new Error(`unexpected ${name}`);
    },
  };

  await assert.rejects(
    remoteRootExec(
      { target: 'taylan', command: 'id -u' },
      {
        env: { PTEXT_ROOT_TARGETS: 'taylan' },
        randomTokenImpl: () => 'deadbeef',
        resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
        upstreamClient,
        remoteExecImpl: async (request) => {
          if (request.command === 'id -u') return commandResult({ stdout: '1000\n' });
          if (request.command === 'command -v sudo >/dev/null 2>&1') return commandResult();
          if (request.command === 'sudo -n -- /bin/bash -lc true') return commandResult({ exit_code: 1 });
          if (request.command === 'command -v docker >/dev/null 2>&1') return commandResult({ exit_code: 1 });
          return commandResult({ exit_code: 1 });
        },
      },
    ),
    (error) => error?.category === 'permission_privilege_error'
      && Array.isArray(error?.details?.attempts)
      && error.details.attempts.some((attempt) => attempt.strategy === 'sudo_password'),
  );
});
