import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStateStore } from '../src/state-store.mjs';
import {
  SESSION_TOOLS,
  callSessionTool,
} from '../src/session-tools.mjs';

async function makeStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-session-tools-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return createStateStore(path.join(dir, 'state.json'));
}

async function seedSession(store, overrides = {}) {
  await store.update((state) => {
    state.sessions.main = {
      name: 'main',
      target: 'test-host',
      cwd: '/srv/work',
      tags: ['primary'],
      local_session_id: 'local-main',
      remote_session_id: 'remote-main',
      created_at: '2026-08-17T00:00:00.000Z',
      updated_at: '2026-08-17T00:00:00.000Z',
      ...overrides,
    };
  });
}

function structured(result) {
  assert.equal(result.isError, undefined);
  return result.structuredContent;
}

test('ensure_session schema requires name and target and advertises persistent default', () => {
  const tool = SESSION_TOOLS.find((item) => item.name === 'ensure_session');

  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['name', 'target']);
  assert.equal(tool.inputSchema.properties.persistent.default, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test('ensure_session defaults to persistent behavior and delegates to the recovery engine', async () => {
  const calls = [];
  const expected = {
    session_id: 'local-main',
    remote_session_id: 'remote-main',
    reused: true,
    recovered: false,
  };

  const result = await callSessionTool(
    'ensure_session',
    { name: 'main', target: 'test-host', cwd: '/srv/work', tags: ['primary'] },
    {
      ensureSessionImpl: async (args) => {
        calls.push(args);
        return expected;
      },
    },
  );

  assert.deepEqual(structured(result), expected);
  assert.deepEqual(calls, [{ name: 'main', target: 'test-host', cwd: '/srv/work', tags: ['primary'] }]);
});

test('ensure_session rejects persistent false instead of creating an ephemeral named session', async () => {
  const result = await callSessionTool(
    'ensure_session',
    { name: 'main', target: 'test-host', persistent: false },
    {
      ensureSessionImpl: async () => {
        throw new Error('must not delegate');
      },
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.category, 'validation_error');
  assert.match(result.structuredContent.message, /persistent/i);
});

test('named_session_list returns registry metadata without terminal output', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);

  const result = await callSessionTool('named_session_list', {}, { stateStore });
  const payload = structured(result);

  assert.equal(payload.sessions.length, 1);
  assert.deepEqual(payload.sessions[0], {
    name: 'main',
    target: 'test-host',
    cwd: '/srv/work',
    tags: ['primary'],
    local_session_id: 'local-main',
    remote_session_id: 'remote-main',
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
  });
  assert.equal('scrollback' in payload.sessions[0], false);
  assert.equal('password' in payload.sessions[0], false);
});

test('named_session_detach detaches the local handle and preserves remote identity', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);
  const calls = [];
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name !== 'detach_session') throw new Error(`unexpected tool ${name}`);
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    },
  };

  const result = await callSessionTool(
    'named_session_detach',
    { name: 'main' },
    { stateStore, upstreamClient, now: () => '2026-08-17T01:00:00.000Z' },
  );

  assert.deepEqual(structured(result), {
    name: 'main',
    remote_session_id: 'remote-main',
    detached: true,
    already_detached: false,
  });
  assert.deepEqual(calls, [{ name: 'detach_session', args: { session_id: 'local-main' } }]);

  const state = await stateStore.read();
  assert.equal(state.sessions.main.local_session_id, null);
  assert.equal(state.sessions.main.remote_session_id, 'remote-main');
  assert.equal(state.sessions.main.updated_at, '2026-08-17T01:00:00.000Z');
});

test('named_session_detach is idempotent when the named session is already detached', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore, { local_session_id: null });

  const result = await callSessionTool(
    'named_session_detach',
    { name: 'main' },
    {
      stateStore,
      upstreamClient: { callTool: async () => { throw new Error('must not call upstream'); } },
    },
  );

  assert.deepEqual(structured(result), {
    name: 'main',
    remote_session_id: 'remote-main',
    detached: true,
    already_detached: true,
  });
});

test('named_session_close closes upstream first and removes the named mapping only after success', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);
  const calls = [];
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name !== 'close_session') throw new Error(`unexpected tool ${name}`);
      const before = await stateStore.read();
      assert.ok(before.sessions.main, 'mapping must still exist while upstream close is executing');
      return { content: [{ type: 'text', text: '{"success":true}' }] };
    },
  };

  const result = await callSessionTool(
    'named_session_close',
    { name: 'main' },
    { stateStore, upstreamClient },
  );

  assert.deepEqual(structured(result), {
    name: 'main',
    remote_session_id: 'remote-main',
    closed: true,
  });
  assert.deepEqual(calls, [{ name: 'close_session', args: { session_id: 'local-main' } }]);
  const state = await stateStore.read();
  assert.equal(state.sessions.main, undefined);
});

test('named_session_close preserves the mapping if upstream close fails', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);

  const result = await callSessionTool(
    'named_session_close',
    { name: 'main' },
    {
      stateStore,
      upstreamClient: { callTool: async () => { throw new Error('upstream close failed'); } },
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.category, 'local_capability_dependency_error');
  const state = await stateStore.read();
  assert.ok(state.sessions.main);
});

test('named session mutation tools reject unknown names without calling upstream', async (t) => {
  const stateStore = await makeStore(t);
  const upstreamClient = { callTool: async () => { throw new Error('must not call upstream'); } };

  for (const name of ['named_session_detach', 'named_session_close']) {
    const result = await callSessionTool(name, { name: 'missing' }, { stateStore, upstreamClient });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.category, 'stale_session_task_forward_id');
  }
});
