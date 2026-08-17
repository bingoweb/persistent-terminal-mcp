import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStateStore } from '../src/state-store.mjs';
import {
  ensureSession,
  forgetLocalSessionHandle,
  listNamedSessions,
} from '../src/session-registry.mjs';

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

async function makeStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-session-registry-'));
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
      local_session_id: 'local-old',
      remote_session_id: 'remote-stable',
      created_at: '2026-08-17T00:00:00.000Z',
      updated_at: '2026-08-17T00:00:00.000Z',
      ...overrides,
    };
  });
}

function resolvedTarget(alias = 'test-host') {
  return { alias, host: alias, hostname: '203.0.113.10', user: 'tester', port: 22 };
}

test('healthy local session is reused without remote discovery or creation', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);
  const calls = [];
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_session_state') {
        return toolResult({ session_id: 'local-old', is_alive: true, state: 'at_prompt' });
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await ensureSession(
    { name: 'main', target: 'test-host', cwd: '/srv/work', tags: ['primary'] },
    { stateStore, upstreamClient, resolveTargetImpl: async () => resolvedTarget() },
  );

  assert.deepEqual(result, {
    session_id: 'local-old',
    remote_session_id: 'remote-stable',
    reused: true,
    recovered: false,
  });
  assert.deepEqual(calls, [{ name: 'get_session_state', args: { session_id: 'local-old' } }]);
});

test('stale local handle reattaches to the recorded live remote session without closing it', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);
  const calls = [];
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_session_state') {
        return toolResult({ session_id: 'local-old', is_alive: false, state: 'unknown' });
      }
      if (name === 'list_remote_sessions') {
        return toolResult([{ id: 'remote-stable', status: 'running' }]);
      }
      if (name === 'create_ssh_session') {
        assert.equal(args.session_id, 'remote-stable');
        assert.equal(args.persistent, true);
        return toolResult({ session_id: 'local-new', target: 'tester@test-host', type: 'remote' });
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await ensureSession(
    { name: 'main', target: 'test-host' },
    { stateStore, upstreamClient, resolveTargetImpl: async () => resolvedTarget() },
  );

  assert.deepEqual(result, {
    session_id: 'local-new',
    remote_session_id: 'remote-stable',
    reused: false,
    recovered: true,
  });
  assert.equal(calls.some((call) => call.name === 'close_session'), false);
  const named = await listNamedSessions({ stateStore });
  assert.equal(named[0].local_session_id, 'local-new');
  assert.equal(named[0].remote_session_id, 'remote-stable');
});

test('confirmed missing remote session creates one new persistent remote PTY and records its remote id', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);
  const calls = [];
  let remoteListCount = 0;
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_session_state') {
        throw new Error('stale local session id');
      }
      if (name === 'list_remote_sessions') {
        remoteListCount += 1;
        return toolResult(remoteListCount === 1
          ? [{ id: 'some-other-session', status: 'running' }]
          : [
              { id: 'some-other-session', status: 'running' },
              { id: 'remote-new', status: 'running' },
            ]);
      }
      if (name === 'create_ssh_session') {
        assert.equal(args.session_id, undefined);
        assert.equal(args.persistent, true);
        assert.equal(args.command, undefined, 'persistent upstream treats command as an executable path, not a shell command');
        return toolResult({ session_id: 'local-created', target: 'tester@test-host', type: 'remote' });
      }
      if (name === 'send_input') {
        assert.deepEqual(args, {
          session_id: 'local-created',
          input: "cd '/srv/work'",
        });
        return toolResult({ is_complete: true });
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const result = await ensureSession(
    { name: 'main', target: 'test-host', cwd: '/srv/work', tags: ['new'] },
    { stateStore, upstreamClient, resolveTargetImpl: async () => resolvedTarget() },
  );

  assert.deepEqual(result, {
    session_id: 'local-created',
    remote_session_id: 'remote-new',
    reused: false,
    recovered: false,
  });
  assert.equal(remoteListCount, 2);
  assert.equal(calls.filter((call) => call.name === 'send_input').length, 1);
  assert.equal(calls.some((call) => call.name === 'close_session'), false);
});

test('cwd initialization failure closes the just-created persistent session', async (t) => {
  const stateStore = await makeStore(t);
  const calls = [];
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_remote_sessions') return toolResult([]);
      if (name === 'create_ssh_session') {
        return toolResult({ session_id: 'local-created', target: 'tester@test-host', type: 'remote' });
      }
      if (name === 'send_input') {
        return {
          content: [{ type: 'text', text: '{"code":"INTERNAL_ERROR","message":"cd failed"}' }],
          isError: true,
        };
      }
      if (name === 'close_session') return toolResult({ success: true });
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => ensureSession(
      { name: 'main', target: 'test-host', cwd: '/does-not-exist' },
      { stateStore, upstreamClient, resolveTargetImpl: async () => resolvedTarget() },
    ),
    /send_input.*failed/i,
  );

  assert.deepEqual(
    calls.filter((call) => call.name === 'close_session'),
    [{ name: 'close_session', args: { session_id: 'local-created' } }],
  );
  const state = await stateStore.read();
  assert.equal(state.sessions.main, undefined);
});

test('remote id discovery failure closes the just-created persistent session', async (t) => {
  const stateStore = await makeStore(t);
  const calls = [];
  let remoteListCount = 0;
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_remote_sessions') {
        remoteListCount += 1;
        return toolResult([]);
      }
      if (name === 'create_ssh_session') {
        return toolResult({ session_id: 'local-created', target: 'tester@test-host', type: 'remote' });
      }
      if (name === 'close_session') return toolResult({ success: true });
      throw new Error(`unexpected tool ${name}`);
    },
  };

  await assert.rejects(
    () => ensureSession(
      { name: 'main', target: 'test-host' },
      { stateStore, upstreamClient, resolveTargetImpl: async () => resolvedTarget() },
    ),
    /Could not uniquely identify the new remote ai-tmux session/i,
  );

  assert.equal(remoteListCount, 2);
  assert.deepEqual(
    calls.filter((call) => call.name === 'close_session'),
    [{ name: 'close_session', args: { session_id: 'local-created' } }],
  );
});

test('a named session cannot silently move to a different target', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);

  await assert.rejects(
    () => ensureSession(
      { name: 'main', target: 'other-host' },
      {
        stateStore,
        upstreamClient: { callTool: async () => { throw new Error('must not call upstream'); } },
        resolveTargetImpl: async () => resolvedTarget('other-host'),
      },
    ),
    /already mapped.*test-host/i,
  );
});

test('forgetLocalSessionHandle removes only the local handle and never remote identity', async (t) => {
  const stateStore = await makeStore(t);
  await seedSession(stateStore);

  const changed = await forgetLocalSessionHandle('local-old', { stateStore });
  assert.equal(changed, true);

  const named = await listNamedSessions({ stateStore });
  assert.equal(named[0].local_session_id, null);
  assert.equal(named[0].remote_session_id, 'remote-stable');
});
