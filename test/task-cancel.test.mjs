import test from 'node:test';
import assert from 'node:assert/strict';

import { cancelTask } from '../src/task-manager.mjs';
import { TASK_TOOLS, callTaskTool } from '../src/task-tools.mjs';

const MARKER = '__PTEXT_TASK_abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef_EXIT=';

function runningTask(overrides = {}) {
  return {
    task_id: 'task_cancel_001',
    target: 'taylan',
    session_id: 'local-task-only',
    remote_session_id: 'remote-task-only',
    command: 'sleep 300',
    state: 'running',
    started_at: '2026-08-17T07:00:00.000Z',
    cursor: 0,
    marker: MARKER,
    ...overrides,
  };
}

function fakeStateStore(record = runningTask()) {
  let current = structuredClone(record);
  const calls = [];
  return {
    calls,
    async getTask(taskId) {
      return current?.task_id === taskId ? structuredClone(current) : null;
    },
    async putTask(next) {
      calls.push({ op: 'put', record: structuredClone(next) });
      current = structuredClone(next);
      return structuredClone(next);
    },
    async listTasks() {
      return current ? [structuredClone(current)] : [];
    },
  };
}

function json(value, { isError = false } = {}) {
  const result = { structuredContent: value };
  if (isError) result.isError = true;
  return result;
}

function liveRemote() {
  return json([{ id: 'remote-task-only', is_alive: true }, { id: 'remote-unrelated', is_alive: true }]);
}

function liveLocal() {
  return json({ session_id: 'local-task-only', is_alive: true, cursor: 0, state: 'running' });
}

test('task_cancel sends Ctrl-C only to the recorded task PTY, waits once for its marker, and leaves unrelated sessions untouched', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  const upstreamClient = {
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') return liveRemote();
      if (name === 'get_session_state') return liveLocal();
      if (name === 'read_output' && 'since_cursor' in args) {
        return json({ cursor: 20, has_more: false, is_truncated: false, is_alive: true, output: 'still sleeping\n' });
      }
      if (name === 'send_control') return json({ ok: true });
      if (name === 'read_output' && 'wait_for' in args) {
        return json({ matched: true, match_line: `${MARKER}130__`, cursor: 48, is_alive: true });
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  const cancelled = await cancelTask('task_cancel_001', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    timeout: 5,
  });

  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(cancelled.terminated_session, false);
  assert.deepEqual(
    calls.filter((call) => call.name === 'send_control'),
    [{ name: 'send_control', args: { session_id: 'local-task-only', key: 'ctrl+c' } }],
  );
  assert.equal(calls.some((call) => call.name === 'close_session'), false);
  assert.equal(
    calls.some((call) => JSON.stringify(call.args).includes('remote-unrelated')),
    false,
  );
  const waits = calls.filter((call) => call.name === 'read_output' && 'wait_for' in call.args);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].args.session_id, 'local-task-only');
  assert.equal(waits[0].args.timeout, 5);
});

test('terminate_session true closes only the dedicated recorded task session after the Ctrl-C attempt', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  const upstreamClient = {
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') return liveRemote();
      if (name === 'get_session_state') return liveLocal();
      if (name === 'read_output' && 'since_cursor' in args) {
        return json({ cursor: 5, has_more: false, is_truncated: false, is_alive: true, output: '' });
      }
      if (name === 'send_control') return json({ ok: true });
      if (name === 'read_output' && 'wait_for' in args) {
        return json({ matched: false, timed_out: true, cursor: 5, is_alive: true });
      }
      if (name === 'close_session') return json({ closed: true });
      throw new Error(`unexpected ${name}`);
    },
  };

  const cancelled = await cancelTask('task_cancel_001', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    timeout: 1,
    terminateSession: true,
  });

  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(cancelled.terminated_session, true);
  assert.deepEqual(
    calls.filter((call) => ['send_control', 'close_session'].includes(call.name)),
    [
      { name: 'send_control', args: { session_id: 'local-task-only', key: 'ctrl+c' } },
      { name: 'close_session', args: { session_id: 'local-task-only' } },
    ],
  );
});

test('terminate_session true does not close the task session when Ctrl-C reaches the completion marker', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  const upstreamClient = {
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') return liveRemote();
      if (name === 'get_session_state') return liveLocal();
      if (name === 'read_output' && 'since_cursor' in args) {
        return json({ cursor: 5, has_more: false, is_truncated: false, is_alive: true, output: '' });
      }
      if (name === 'send_control') return json({ ok: true });
      if (name === 'read_output' && 'wait_for' in args) {
        return json({ matched: true, match_line: `${MARKER}130__`, cursor: 24, is_alive: true });
      }
      if (name === 'close_session') return json({ closed: true });
      throw new Error(`unexpected ${name}`);
    },
  };

  const cancelled = await cancelTask('task_cancel_001', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    timeout: 1,
    terminateSession: true,
  });

  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(cancelled.terminated_session, false);
  assert.equal(calls.some((call) => call.name === 'close_session'), false);
});

test('bounded cancellation timeout without terminate_session keeps task running instead of claiming cancellation', async () => {
  const stateStore = fakeStateStore();
  const upstreamClient = {
    async callTool(name, args) {
      if (name === 'list_remote_sessions') return liveRemote();
      if (name === 'get_session_state') return liveLocal();
      if (name === 'read_output' && 'since_cursor' in args) {
        return json({ cursor: 5, has_more: false, is_truncated: false, is_alive: true, output: '' });
      }
      if (name === 'send_control') return json({ ok: true });
      if (name === 'read_output' && 'wait_for' in args) {
        return json({ matched: false, timed_out: true, cursor: 5, is_alive: true });
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  await assert.rejects(
    () => cancelTask('task_cancel_001', {
      stateStore,
      upstreamClient,
      resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
      timeout: 2,
    }),
    (error) => error.category === 'timeout',
  );
  assert.notEqual(stateStore.calls.at(-1)?.record?.state, 'cancelled');
});

test('already-terminal task is returned without sending Ctrl-C', async () => {
  const stateStore = fakeStateStore(runningTask({ state: 'succeeded', exit_code: 0 }));
  let upstreamCalled = false;
  const result = await cancelTask('task_cancel_001', {
    stateStore,
    upstreamClient: { callTool: async () => { upstreamCalled = true; } },
  });
  assert.equal(result.task.state, 'succeeded');
  assert.equal(result.terminated_session, false);
  assert.equal(upstreamCalled, false);
});

test('task_cancel tool schema makes termination explicit and does not leak task internals', async () => {
  const tool = TASK_TOOLS.find((item) => item.name === 'task_cancel');
  assert.ok(tool, 'missing task_cancel');
  assert.equal(tool.inputSchema.properties.terminate_session.type, 'boolean');
  assert.equal(tool.inputSchema.properties.terminate_session.default, false);
  assert.equal(tool.inputSchema.properties.timeout.maximum, 30);

  const internal = runningTask();
  const response = await callTaskTool('task_cancel', {
    task_id: internal.task_id,
    terminate_session: true,
    timeout: 4,
  }, {
    taskManager: {
      cancel: async () => ({ task: { ...internal, state: 'cancelled' }, terminated_session: true }),
    },
  });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.state, 'cancelled');
  assert.equal(response.structuredContent.terminated_session, true);
  const serialized = JSON.stringify(response.structuredContent);
  assert.equal(serialized.includes(internal.command), false);
  assert.equal(serialized.includes(internal.marker), false);
  assert.equal(serialized.includes(internal.session_id), false);
});
