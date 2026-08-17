import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStateStore } from '../src/state-store.mjs';

async function tempStatePath(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

test('read returns the versioned empty state when no file exists', async (t) => {
  const statePath = await tempStatePath(t);
  const store = createStateStore(statePath);

  assert.deepEqual(await store.read(), {
    version: 1,
    sessions: {},
    tasks: {},
    forwards: {},
  });
});

test('interruption before rename leaves the previous JSON state intact', async (t) => {
  const statePath = await tempStatePath(t);
  const store = createStateStore(statePath);

  await store.update((state) => {
    state.sessions.stable = { remote_session_id: 'remote-1' };
  });
  const before = JSON.parse(await fs.readFile(statePath, 'utf8'));

  const interruptedFs = {
    ...fs,
    rename: async () => {
      throw new Error('simulated interruption before rename');
    },
  };
  const interruptedStore = createStateStore(statePath, { fsImpl: interruptedFs });

  await assert.rejects(
    () => interruptedStore.update((state) => {
      state.sessions.uncommitted = { remote_session_id: 'remote-2' };
    }),
    /simulated interruption/i,
  );

  const rawAfter = await fs.readFile(statePath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(rawAfter));
  assert.deepEqual(JSON.parse(rawAfter), before);
  assert.equal(JSON.parse(rawAfter).sessions.uncommitted, undefined);
});

test('update accepts an immutable replacement returned by the mutator', async (t) => {
  const statePath = await tempStatePath(t);
  const store = createStateStore(statePath);

  const result = await store.update((state) => ({
    ...state,
    sessions: { named: { remote_session_id: 'r3' } },
  }));

  assert.equal(result.sessions.named.remote_session_id, 'r3');
  assert.deepEqual(await store.read(), result);
});
