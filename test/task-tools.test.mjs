import test from 'node:test';
import assert from 'node:assert/strict';

import {
  completionPattern,
  getTaskStatus,
  listTasks,
  readTaskOutput,
  waitForTask,
} from '../src/task-manager.mjs';
import { TASK_TOOLS, callTaskTool } from '../src/task-tools.mjs';
import { buildToolCatalog, callTool } from '../src/tool-registry.mjs';

const MARKER = '__PTEXT_TASK_0123456789abcdef0123456789abcdef0123456789abcdef_EXIT=';

function runningTask(overrides = {}) {
  return {
    task_id: 'task_00112233445566778899aabb',
    target: 'taylan',
    session_id: 'local-old',
    remote_session_id: 'remote-task-1',
    command: 'printf "hello\\n"',
    state: 'running',
    started_at: '2026-08-17T06:00:00.000Z',
    cursor: 0,
    marker: MARKER,
    ...overrides,
  };
}

function fakeStateStore(records = [runningTask()]) {
  const tasks = new Map(records.map((record) => [record.task_id, structuredClone(record)]));
  const calls = [];
  return {
    calls,
    async getTask(taskId) {
      const record = tasks.get(taskId);
      return record ? structuredClone(record) : null;
    },
    async putTask(record) {
      calls.push({ op: 'put', record: structuredClone(record) });
      tasks.set(record.task_id, structuredClone(record));
      return structuredClone(record);
    },
    async listTasks() {
      return [...tasks.values()].map((record) => structuredClone(record));
    },
  };
}

function json(value, { isError = false } = {}) {
  const result = { structuredContent: value };
  if (isError) result.isError = true;
  return result;
}

function aliveRemoteList() {
  return json([{ id: 'remote-task-1', is_alive: true }]);
}

function aliveLocalState() {
  return json({ session_id: 'local-old', is_alive: true, cursor: 0, state: 'running' });
}

function tool(name) {
  const found = TASK_TOOLS.find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

function schemaPropertyNames(value, names = new Set()) {
  if (!value || typeof value !== 'object') return names;
  if (value.properties && typeof value.properties === 'object') {
    for (const key of Object.keys(value.properties)) names.add(key);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) schemaPropertyNames(item, names);
    } else if (child && typeof child === 'object') {
      schemaPropertyNames(child, names);
    }
  }
  return names;
}

test('canonical task schemas are bounded and omit internal marker/session fields from public results', () => {
  for (const name of ['task_start', 'task_status', 'task_output', 'task_wait', 'task_list']) tool(name);

  const wait = tool('task_wait');
  assert.equal(wait.inputSchema.properties.timeout.maximum, 600);
  assert.equal(wait.inputSchema.properties.timeout.default, 30);

  const output = tool('task_output');
  assert.equal(output.inputSchema.properties.max_bytes.maximum, 262144);
  assert.equal(output.inputSchema.properties.max_bytes.default, 32768);

  for (const item of TASK_TOOLS) {
    const names = schemaPropertyNames(item.outputSchema);
    assert.equal(names.has('marker'), false, `${item.name} exposes marker`);
    assert.equal(names.has('session_id'), false, `${item.name} exposes local session id`);
    assert.equal(names.has('command'), false, `${item.name} exposes stored command`);
  }
});

test('task_output advances cursor and recognizes a completion marker split across incremental reads', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  const outputs = [
    {
      cursor: 100,
      has_more: true,
      is_truncated: false,
      is_alive: true,
      output: `echo '${MARKER}7__'\nhello\n${MARKER}0`,
    },
    {
      cursor: 106,
      has_more: false,
      is_truncated: false,
      is_alive: true,
      output: '__\n',
    },
  ];
  const upstreamClient = {
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') return aliveRemoteList();
      if (name === 'get_session_state') return aliveLocalState();
      if (name === 'read_output') return json(outputs.shift());
      throw new Error(`unexpected ${name}`);
    },
  };

  const first = await readTaskOutput('task_00112233445566778899aabb', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    maxBytes: 32768,
  });
  assert.equal(first.task.state, 'running');
  assert.equal(first.cursor, 100);
  assert.equal(first.has_more, true);
  assert.equal(first.output.includes(`echo '${MARKER}7__'`), true);

  const second = await readTaskOutput('task_00112233445566778899aabb', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    maxBytes: 32768,
  });
  assert.equal(second.task.state, 'succeeded');
  assert.equal(second.task.exit_code, 0);
  assert.equal(second.cursor, 106);
  assert.deepEqual(
    calls.filter((call) => call.name === 'read_output').map((call) => call.args),
    [
      { session_id: 'local-old', since_cursor: 0, max_bytes: 32768 },
      { session_id: 'local-old', since_cursor: 100, max_bytes: 32768 },
    ],
  );
});

test('task_output maps an anchored exit 7 marker to failed while ignoring marker text inside command echo', async () => {
  const stateStore = fakeStateStore();
  const upstreamClient = {
    async callTool(name) {
      if (name === 'list_remote_sessions') return aliveRemoteList();
      if (name === 'get_session_state') return aliveLocalState();
      if (name === 'read_output') {
        return json({
          cursor: 90,
          has_more: false,
          is_truncated: false,
          is_alive: true,
          output: `printf '${MARKER}0__'\nreal output\n${MARKER}7__\n`,
        });
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  const read = await readTaskOutput('task_00112233445566778899aabb', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
  });
  assert.equal(read.task.state, 'failed');
  assert.equal(read.task.exit_code, 7);
});

test('task_status reattaches only to the recorded live remote session after the local handle is stale', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  const upstreamClient = {
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') return aliveRemoteList();
      if (name === 'get_session_state') return json({ message: 'unknown local session' }, { isError: true });
      if (name === 'create_ssh_session') {
        return json({ session_id: 'local-reattached', target: 'bingoweb@taylan', type: 'remote' });
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  const status = await getTaskStatus('task_00112233445566778899aabb', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
  });

  assert.equal(status.state, 'running');
  assert.equal(status.session_id, 'local-reattached');
  assert.equal(status.remote_session_id, 'remote-task-1');
  assert.deepEqual(
    calls.filter((call) => call.name === 'create_ssh_session'),
    [{
      name: 'create_ssh_session',
      args: { host: 'taylan', user: 'bingoweb', persistent: true, session_id: 'remote-task-1' },
    }],
  );
});

test('missing recorded remote session marks a running task lost and never creates a replacement session', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  const upstreamClient = {
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') return json([{ id: 'some-other-session', is_alive: true }]);
      throw new Error(`unexpected ${name}`);
    },
  };

  const status = await getTaskStatus('task_00112233445566778899aabb', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
  });
  assert.equal(status.state, 'lost');
  assert.equal(calls.some((call) => call.name === 'create_ssh_session'), false);
  assert.equal(stateStore.calls.at(-1).record.state, 'lost');
});

test('task_wait first drains buffered output, then uses one bounded anchored read_output wait_for call', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  let incrementalReads = 0;
  const upstreamClient = {
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') return aliveRemoteList();
      if (name === 'get_session_state') return aliveLocalState();
      if (name === 'read_output' && 'since_cursor' in args) {
        incrementalReads += 1;
        return json({
          cursor: 50,
          has_more: false,
          is_truncated: false,
          is_alive: true,
          output: 'still running\n',
        });
      }
      if (name === 'read_output' && 'wait_for' in args) {
        return json({
          matched: true,
          match_line: `${MARKER}7__`,
          cursor: 75,
          is_alive: true,
        });
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  const waited = await waitForTask('task_00112233445566778899aabb', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    timeout: 42,
  });

  assert.equal(incrementalReads, 1);
  assert.equal(waited.task.state, 'failed');
  assert.equal(waited.task.exit_code, 7);
  assert.equal(waited.timed_out, false);
  const waits = calls.filter((call) => call.name === 'read_output' && 'wait_for' in call.args);
  assert.equal(waits.length, 1);
  assert.deepEqual(waits[0].args, {
    session_id: 'local-old',
    wait_for: completionPattern(MARKER),
    timeout: 42,
    tail_lines: 0,
  });
  assert.equal(waits[0].args.wait_for.startsWith('^'), true);
  assert.equal(waits[0].args.wait_for.endsWith('$'), true);
});

test('task_wait timeout stays running and respects the 600 second maximum', async () => {
  const stateStore = fakeStateStore();
  const upstreamClient = {
    async callTool(name, args) {
      if (name === 'list_remote_sessions') return aliveRemoteList();
      if (name === 'get_session_state') return aliveLocalState();
      if (name === 'read_output' && 'since_cursor' in args) {
        return json({ cursor: 10, has_more: false, is_truncated: false, is_alive: true, output: '' });
      }
      if (name === 'read_output' && 'wait_for' in args) {
        assert.equal(args.timeout, 600);
        return json({ matched: false, timed_out: true, cursor: 10, is_alive: true });
      }
      throw new Error(`unexpected ${name}`);
    },
  };

  const waited = await waitForTask('task_00112233445566778899aabb', {
    stateStore,
    upstreamClient,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    timeout: 600,
  });
  assert.equal(waited.task.state, 'running');
  assert.equal(waited.timed_out, true);

  await assert.rejects(
    () => waitForTask('task_00112233445566778899aabb', {
      stateStore,
      upstreamClient,
      resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
      timeout: 601,
    }),
    /timeout/u,
  );
});

test('missing task id uses the stale task/session/forward category without touching upstream', async () => {
  let upstreamCalled = false;
  await assert.rejects(
    () => getTaskStatus('task_missing', {
      stateStore: fakeStateStore([]),
      upstreamClient: { callTool: async () => { upstreamCalled = true; } },
    }),
    (error) => error.category === 'stale_session_task_forward_id',
  );
  assert.equal(upstreamCalled, false);
});

test('task_list returns persisted tasks without terminal output or upstream probes', async () => {
  const records = [
    runningTask(),
    runningTask({ task_id: 'task_second', state: 'succeeded', exit_code: 0 }),
  ];
  const listed = await listTasks({ stateStore: fakeStateStore(records) });
  assert.equal(listed.length, 2);
});

test('task tools are published and unified registry routes them locally', async () => {
  const catalog = buildToolCatalog({ upstreamTools: [] });
  for (const name of ['task_start', 'task_status', 'task_output', 'task_wait', 'task_list']) {
    assert(catalog.some((item) => item.name === name), `catalog missing ${name}`);
  }

  const expected = { structuredContent: { sentinel: true }, content: [] };
  const calls = [];
  const returned = await callTool('task_status', { task_id: 'task_x' }, {
    upstreamClient: { callTool: async () => { throw new Error('must not forward upstream'); } },
    upstreamToolNames: new Set(),
    taskToolCallImpl: async (name, args) => {
      calls.push({ name, args });
      return expected;
    },
  });
  assert.strictEqual(returned, expected);
  assert.deepEqual(calls, [{ name: 'task_status', args: { task_id: 'task_x' } }]);
});

test('task tool public responses never expose command, marker, or local session id', async () => {
  const internal = runningTask();
  const manager = {
    start: async () => internal,
    status: async () => internal,
    output: async () => ({
      task: internal,
      output: 'hello\n',
      cursor: 5,
      has_more: false,
      is_truncated: false,
    }),
    wait: async () => ({ task: internal, timed_out: false }),
    list: async () => [internal],
  };

  for (const [name, args] of [
    ['task_start', { target: 'taylan', command: 'secret-ish command' }],
    ['task_status', { task_id: internal.task_id }],
    ['task_output', { task_id: internal.task_id }],
    ['task_wait', { task_id: internal.task_id }],
    ['task_list', {}],
  ]) {
    const response = await callTaskTool(name, args, { taskManager: manager });
    const text = JSON.stringify(response.structuredContent);
    assert.equal(text.includes(internal.command), false, `${name} leaked command`);
    assert.equal(text.includes(internal.marker), false, `${name} leaked marker`);
    assert.equal(text.includes(internal.session_id), false, `${name} leaked local session id`);
  }
});
