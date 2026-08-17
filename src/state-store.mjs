import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { TerminalError } from './errors.mjs';

export const DEFAULT_STATE_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'persistent-terminal-extended',
  'state.json',
);

function emptyState() {
  return {
    version: 1,
    sessions: {},
    tasks: {},
    forwards: {},
  };
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TerminalError('validation_error', 'Persistent Terminal state must be an object');
  }
  if (state.version !== 1) {
    throw new TerminalError('validation_error', `Unsupported Persistent Terminal state version: ${state.version}`);
  }
  for (const key of ['sessions', 'tasks', 'forwards']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) {
      throw new TerminalError('validation_error', `Persistent Terminal state.${key} must be an object`);
    }
  }
  return state;
}

async function readState(statePath, fsImpl) {
  let raw;
  try {
    raw = await fsImpl.readFile(statePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }

  try {
    return validateState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof TerminalError) throw error;
    throw new TerminalError(
      'local_capability_dependency_error',
      `Persistent Terminal state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function atomicWrite(statePath, state, fsImpl) {
  const dir = path.dirname(statePath);
  await fsImpl.mkdir(dir, { recursive: true, mode: 0o700 });

  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsImpl.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(tempPath, statePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fsImpl.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function createStateStore(statePath = DEFAULT_STATE_PATH, { fsImpl = fs } = {}) {
  if (typeof statePath !== 'string' || statePath.length === 0 || statePath.includes('\0')) {
    throw new TerminalError('validation_error', 'State path must be a non-empty path without NUL bytes');
  }

  let updateQueue = Promise.resolve();

  async function read() {
    return readState(statePath, fsImpl);
  }

  async function performUpdate(mutator) {
    if (typeof mutator !== 'function') {
      throw new TerminalError('validation_error', 'State update requires a mutator function');
    }

    const current = await read();
    const draft = structuredClone(current);
    const replacement = await mutator(draft);
    const next = validateState(replacement === undefined ? draft : replacement);

    await atomicWrite(statePath, next, fsImpl);
    return structuredClone(next);
  }

  function update(mutator) {
    const queued = updateQueue.then(
      () => performUpdate(mutator),
      () => performUpdate(mutator),
    );
    updateQueue = queued.catch(() => {});
    return queued;
  }

  async function listForwards() {
    const state = await read();
    return Object.values(state.forwards).map((record) => structuredClone(record));
  }

  async function getForward(forwardId) {
    if (typeof forwardId !== 'string' || forwardId.length === 0 || forwardId.includes('\0')) {
      throw new TerminalError('validation_error', 'forward_id must be a non-empty string without NUL bytes');
    }
    const state = await read();
    const record = state.forwards[forwardId];
    return record === undefined ? null : structuredClone(record);
  }

  async function putForward(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TerminalError('validation_error', 'forward record must be an object');
    }
    if (typeof record.forward_id !== 'string' || record.forward_id.length === 0 || record.forward_id.includes('\0')) {
      throw new TerminalError('validation_error', 'forward record requires a non-empty forward_id');
    }
    await update((draft) => {
      draft.forwards[record.forward_id] = structuredClone(record);
    });
    return structuredClone(record);
  }

  async function deleteForward(forwardId) {
    if (typeof forwardId !== 'string' || forwardId.length === 0 || forwardId.includes('\0')) {
      throw new TerminalError('validation_error', 'forward_id must be a non-empty string without NUL bytes');
    }
    await update((draft) => {
      delete draft.forwards[forwardId];
    });
  }

  return {
    read,
    update,
    listForwards,
    getForward,
    putForward,
    deleteForward,
  };
}
