import test from 'node:test';
import assert from 'node:assert/strict';

import { startTask } from '../src/task-manager.mjs';

function randomSequence(...hexValues) {
  const values = [...hexValues];
  return (size) => {
    const hex = values.shift();
    assert.ok(hex, 'unexpected randomBytes call');
    const value = Buffer.from(hex, 'hex');
    assert.equal(value.length, size);
    return value;
  };
}

function fakeStateStore() {
  const tasks = new Map();
  const calls = [];
  return {
    calls,
    async putTask(record) {
      calls.push({ op: 'put', record: structuredClone(record) });
      tasks.set(record.task_id, structuredClone(record));
      return structuredClone(record);
    },
    async deleteTask(taskId) {
      calls.push({ op: 'delete', task_id: taskId });
      tasks.delete(taskId);
    },
    async getTask(taskId) {
      const record = tasks.get(taskId);
      return record ? structuredClone(record) : null;
    },
  };
}

function fakeUpstream() {
  let sessionCounter = 0;
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') {
        return {
          structuredContent: Array.from({ length: sessionCounter }, (_, index) => ({
            id: `remote-${index + 1}`,
            is_alive: true,
          })),
        };
      }
      if (name === 'create_ssh_session') {
        sessionCounter += 1;
        return {
          structuredContent: {
            session_id: `local-${sessionCounter}`,
            remote_session_id: `remote-${sessionCounter}`,
          },
        };
      }
      if (name === 'send_input') return { structuredContent: { ok: true } };
      if (name === 'close_session') return { structuredContent: { ok: true } };
      throw new Error(`unexpected upstream tool ${name}`);
    },
  };
}

test('missing create remote_session_id is discovered from the exact before/after remote session diff', async () => {
  const stateStore = fakeStateStore();
  const calls = [];
  let created = false;
  const upstreamClient = {
    calls,
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'list_remote_sessions') {
        return {
          structuredContent: created
            ? [
              { id: 'remote-existing', is_alive: true },
              { id: 'remote-new-task', is_alive: true },
            ]
            : [{ id: 'remote-existing', is_alive: true }],
        };
      }
      if (name === 'create_ssh_session') {
        created = true;
        return { structuredContent: { session_id: 'local-new-task' } };
      }
      if (name === 'send_input') return { structuredContent: { ok: true } };
      if (name === 'close_session') return { structuredContent: { ok: true } };
      throw new Error(`unexpected upstream tool ${name}`);
    },
  };

  const result = await startTask({ target: 'taylan', command: 'sleep 1' }, {
    stateStore,
    upstreamClient,
    randomBytesImpl: randomSequence(
      'abababababababababababab',
      'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    ),
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
    now: () => '2026-08-17T06:03:00.000Z',
  });

  assert.equal(result.session_id, 'local-new-task');
  assert.equal(result.remote_session_id, 'remote-new-task');
  assert.deepEqual(
    calls.filter((call) => call.name === 'list_remote_sessions'),
    [
      { name: 'list_remote_sessions', args: { host: 'taylan', user: 'bingoweb' } },
      { name: 'list_remote_sessions', args: { host: 'taylan', user: 'bingoweb' } },
    ],
  );
});

test('each task gets a unique persistent bash session, task id and non-spoofable completion marker', async () => {
  const stateStore = fakeStateStore();
  const upstreamClient = fakeUpstream();
  const randomBytesImpl = randomSequence(
    '00112233445566778899aabb',
    '000102030405060708090a0b0c0d0e0f1011121314151617',
    'aabbccddeeff001122334455',
    '18191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f',
  );

  const first = await startTask({ target: 'taylan', command: 'printf "first task\\n"' }, {
    stateStore,
    upstreamClient,
    randomBytesImpl,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'ubuntu' }),
    now: () => '2026-08-17T06:00:00.000Z',
  });
  const second = await startTask({ target: 'taylan', command: 'printf "second task\\n"' }, {
    stateStore,
    upstreamClient,
    randomBytesImpl,
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'ubuntu' }),
    now: () => '2026-08-17T06:00:01.000Z',
  });

  assert.equal(first.task_id, 'task_00112233445566778899aabb');
  assert.equal(second.task_id, 'task_aabbccddeeff001122334455');
  assert.notEqual(first.marker, second.marker);
  assert.match(first.marker, /^__PTEXT_TASK_[0-9a-f]{48}_EXIT=$/u);
  assert.match(second.marker, /^__PTEXT_TASK_[0-9a-f]{48}_EXIT=$/u);
  assert.equal(first.session_id, 'local-1');
  assert.equal(first.remote_session_id, 'remote-1');
  assert.equal(second.session_id, 'local-2');
  assert.equal(second.remote_session_id, 'remote-2');

  const creates = upstreamClient.calls.filter((call) => call.name === 'create_ssh_session');
  assert.deepEqual(creates, [
    {
      name: 'create_ssh_session',
      args: { host: 'taylan', user: 'ubuntu', persistent: true, command: '/bin/bash' },
    },
    {
      name: 'create_ssh_session',
      args: { host: 'taylan', user: 'ubuntu', persistent: true, command: '/bin/bash' },
    },
  ]);
});

test('task wrapper keeps the requested command out of shell interpolation and emits the exact marker exit line', async () => {
  const stateStore = fakeStateStore();
  const upstreamClient = fakeUpstream();
  const command = `printf '%s\\n' "value with spaces; $(touch /tmp/not-interpolated-here)"`;
  const result = await startTask({ target: 'box', command }, {
    stateStore,
    upstreamClient,
    randomBytesImpl: randomSequence(
      '111122223333444455556666',
      '000102030405060708090a0b0c0d0e0f1011121314151617',
    ),
    resolveTargetImpl: async () => ({ alias: 'box', user: 'ops' }),
    now: () => '2026-08-17T06:01:00.000Z',
  });

  const send = upstreamClient.calls.find((call) => call.name === 'send_input');
  assert.ok(send);
  assert.equal(send.args.session_id, 'local-1');
  assert.equal(send.args.input.includes(command), false);
  assert.equal(send.args.input.includes(Buffer.from(command, 'utf8').toString('base64')), true);
  assert.equal(send.args.input.includes(result.marker), true);
  assert.match(send.args.input, /printf '\\n%s%s__\\n'/u);
});

test('task metadata is persisted queued before launch and running after send_input succeeds', async () => {
  const stateStore = fakeStateStore();
  const upstreamClient = fakeUpstream();
  const result = await startTask({ target: 'taylan', command: 'sleep 10' }, {
    stateStore,
    upstreamClient,
    randomBytesImpl: randomSequence(
      '010101010101010101010101',
      '020202020202020202020202020202020202020202020202',
    ),
    resolveTargetImpl: async () => ({ alias: 'taylan', user: 'ubuntu' }),
    now: () => '2026-08-17T06:02:00.000Z',
  });

  assert.equal(stateStore.calls.length, 2);
  assert.equal(stateStore.calls[0].record.state, 'queued');
  assert.equal(stateStore.calls[1].record.state, 'running');
  assert.deepEqual(stateStore.calls[1].record, {
    task_id: 'task_010101010101010101010101',
    target: 'taylan',
    session_id: 'local-1',
    remote_session_id: 'remote-1',
    command: 'sleep 10',
    state: 'running',
    started_at: '2026-08-17T06:02:00.000Z',
    cursor: 0,
    marker: '__PTEXT_TASK_020202020202020202020202020202020202020202020202_EXIT=',
  });
  assert.equal(result.state, 'running');
});

test('send_input failure removes task state and closes only the newly-created task session', async () => {
  const stateStore = fakeStateStore();
  const upstreamClient = fakeUpstream();
  upstreamClient.callTool = async (name, args) => {
    upstreamClient.calls.push({ name, args: structuredClone(args) });
    if (name === 'list_remote_sessions') return { structuredContent: [] };
    if (name === 'create_ssh_session') {
      return { structuredContent: { session_id: 'local-fail', remote_session_id: 'remote-fail' } };
    }
    if (name === 'send_input') {
      return { isError: true, structuredContent: { message: 'send failed' } };
    }
    if (name === 'close_session') return { structuredContent: { ok: true } };
    throw new Error(`unexpected tool ${name}`);
  };

  await assert.rejects(
    () => startTask({ target: 'taylan', command: 'sleep 10' }, {
      stateStore,
      upstreamClient,
      randomBytesImpl: randomSequence(
        '030303030303030303030303',
        '040404040404040404040404040404040404040404040404',
      ),
      resolveTargetImpl: async () => ({ alias: 'taylan', user: 'ubuntu' }),
    }),
    /send_input/u,
  );

  assert.equal(stateStore.calls.some((call) => call.op === 'delete'), true);
  assert.deepEqual(
    upstreamClient.calls.filter((call) => call.name === 'close_session'),
    [{ name: 'close_session', args: { session_id: 'local-fail' } }],
  );
});

test('NUL-bearing commands are rejected before creating any upstream session', async () => {
  const upstreamClient = fakeUpstream();
  await assert.rejects(
    () => startTask({ target: 'taylan', command: 'echo ok\0bad' }, {
      stateStore: fakeStateStore(),
      upstreamClient,
    }),
    /NUL/u,
  );
  assert.deepEqual(upstreamClient.calls, []);
});
