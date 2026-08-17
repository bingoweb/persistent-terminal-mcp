import { TerminalError } from './errors.mjs';
import { PtyUpstreamClient } from './upstream-pty.mjs';
import { quotePosix } from './ssh-runner.mjs';
import { createStateStore } from './state-store.mjs';
import { resolveTarget } from './target-resolver.mjs';

const defaultStateStore = createStateStore();
const defaultUpstreamClient = new PtyUpstreamClient();

function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TerminalError('validation_error', 'Session name must be a non-empty string');
  }
  if (name.includes('\0')) {
    throw new TerminalError('validation_error', 'Session name must not contain NUL bytes');
  }
  return name;
}

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TerminalError('validation_error', 'Session target must be a non-empty string');
  }
  if (target.includes('\0')) {
    throw new TerminalError('validation_error', 'Session target must not contain NUL bytes');
  }
  return target;
}

function normalizeTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.includes('\0'))) {
    throw new TerminalError('validation_error', 'Session tags must be an array of strings without NUL bytes');
  }
  return [...new Set(tags)];
}

function validateCwd(cwd) {
  if (cwd === undefined) return null;
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) {
    throw new TerminalError('validation_error', 'Session cwd must be a non-empty string without NUL bytes');
  }
  return cwd;
}

function parseToolJson(result, toolName) {
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new TerminalError(
      'missing_remote_capability',
      `${toolName} did not return JSON text content`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TerminalError(
      'missing_remote_capability',
      `${toolName} returned invalid JSON`,
      { cause: error },
    );
  }
}

function sessionIdFromResult(result, toolName = 'create_ssh_session') {
  const parsed = parseToolJson(result, toolName);
  if (!parsed || typeof parsed.session_id !== 'string' || parsed.session_id.length === 0) {
    throw new TerminalError('missing_remote_capability', `${toolName} did not return session_id`);
  }
  return parsed;
}

async function remoteSessions(upstreamClient, target) {
  const result = await upstreamClient.callTool('list_remote_sessions', {
    host: target.alias,
    user: target.user,
  });
  const parsed = parseToolJson(result, 'list_remote_sessions');
  if (!Array.isArray(parsed)) {
    throw new TerminalError('missing_remote_capability', 'list_remote_sessions did not return an array');
  }
  return parsed;
}

async function localSessionAlive(upstreamClient, localSessionId) {
  if (!localSessionId) return false;
  try {
    const result = await upstreamClient.callTool('get_session_state', {
      session_id: localSessionId,
    });
    const parsed = parseToolJson(result, 'get_session_state');
    return parsed?.is_alive === true;
  } catch {
    return false;
  }
}

function initialCommand(cwd) {
  if (!cwd) return undefined;
  const inner = `cd ${quotePosix(cwd)} && exec /bin/bash`;
  return `/bin/bash -lc ${quotePosix(inner)}`;
}

async function writeSession(stateStore, name, entry) {
  await stateStore.update((state) => {
    state.sessions[name] = entry;
  });
}

function publicResult(entry, { reused, recovered }) {
  return {
    session_id: entry.local_session_id,
    remote_session_id: entry.remote_session_id,
    reused,
    recovered,
  };
}

async function reattachRemote({ upstreamClient, target, remoteSessionId }) {
  const result = await upstreamClient.callTool('create_ssh_session', {
    host: target.alias,
    user: target.user,
    persistent: true,
    session_id: remoteSessionId,
  });
  return sessionIdFromResult(result).session_id;
}

async function createPersistentRemote({ upstreamClient, target, cwd, beforeSessions }) {
  const before = beforeSessions ?? await remoteSessions(upstreamClient, target);
  const beforeIds = new Set(before.map((item) => item?.session_id).filter(Boolean));

  const args = {
    host: target.alias,
    user: target.user,
    persistent: true,
  };
  const command = initialCommand(cwd);
  if (command) args.command = command;

  const createdResult = await upstreamClient.callTool('create_ssh_session', args);
  const created = sessionIdFromResult(createdResult);

  if (typeof created.remote_session_id === 'string' && created.remote_session_id.length > 0) {
    return { localSessionId: created.session_id, remoteSessionId: created.remote_session_id };
  }

  const after = await remoteSessions(upstreamClient, target);
  const newRemoteIds = after
    .map((item) => item?.session_id)
    .filter((id) => typeof id === 'string' && !beforeIds.has(id));

  if (newRemoteIds.length !== 1) {
    throw new TerminalError(
      'missing_remote_capability',
      `Could not uniquely identify the new remote ai-tmux session (${newRemoteIds.length} candidates)`,
      { details: { candidates: newRemoteIds } },
    );
  }

  return { localSessionId: created.session_id, remoteSessionId: newRemoteIds[0] };
}

export async function ensureSession(
  { name, target, cwd, tags } = {},
  {
    stateStore = defaultStateStore,
    upstreamClient = defaultUpstreamClient,
    resolveTargetImpl = resolveTarget,
    now = () => new Date().toISOString(),
  } = {},
) {
  const validatedName = validateName(name);
  const validatedTarget = validateTarget(target);
  const validatedCwd = validateCwd(cwd);
  const normalizedTags = normalizeTags(tags);

  const state = await stateStore.read();
  const existing = state.sessions[validatedName] ?? null;

  if (existing && existing.target !== validatedTarget) {
    throw new TerminalError(
      'validation_error',
      `Named session ${validatedName} is already mapped to ${existing.target}`,
    );
  }

  const resolved = await resolveTargetImpl(validatedTarget);
  if (!resolved?.user) {
    throw new TerminalError('target_resolution_error', `OpenSSH target ${validatedTarget} did not resolve a user`);
  }

  if (existing?.local_session_id && await localSessionAlive(upstreamClient, existing.local_session_id)) {
    return publicResult(existing, { reused: true, recovered: false });
  }

  if (existing?.local_session_id) {
    await forgetLocalSessionHandle(existing.local_session_id, { stateStore, now });
  }

  let confirmedRemoteSnapshot = null;
  if (existing?.remote_session_id) {
    const remotes = await remoteSessions(upstreamClient, resolved);
    confirmedRemoteSnapshot = remotes;
    const remoteExists = remotes.some((item) => item?.session_id === existing.remote_session_id);

    if (remoteExists) {
      const localSessionId = await reattachRemote({
        upstreamClient,
        target: resolved,
        remoteSessionId: existing.remote_session_id,
      });
      const updated = {
        ...existing,
        local_session_id: localSessionId,
        tags: tags === undefined ? existing.tags ?? [] : normalizedTags,
        updated_at: now(),
      };
      await writeSession(stateStore, validatedName, updated);
      return publicResult(updated, { reused: false, recovered: true });
    }
  }

  const created = await createPersistentRemote({
    upstreamClient,
    target: resolved,
    cwd: validatedCwd ?? existing?.cwd ?? null,
    beforeSessions: confirmedRemoteSnapshot,
  });
  const timestamp = now();
  const entry = {
    name: validatedName,
    target: validatedTarget,
    cwd: validatedCwd ?? existing?.cwd ?? null,
    tags: tags === undefined ? existing?.tags ?? [] : normalizedTags,
    local_session_id: created.localSessionId,
    remote_session_id: created.remoteSessionId,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
  };
  await writeSession(stateStore, validatedName, entry);
  return publicResult(entry, { reused: false, recovered: false });
}

export async function listNamedSessions({ stateStore = defaultStateStore } = {}) {
  const state = await stateStore.read();
  return Object.values(state.sessions)
    .map((entry) => structuredClone(entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function forgetLocalSessionHandle(
  localSessionId,
  { stateStore = defaultStateStore, now = () => new Date().toISOString() } = {},
) {
  if (typeof localSessionId !== 'string' || localSessionId.length === 0) {
    throw new TerminalError('validation_error', 'local session id must be a non-empty string');
  }

  let changed = false;
  await stateStore.update((state) => {
    for (const entry of Object.values(state.sessions)) {
      if (entry.local_session_id === localSessionId) {
        entry.local_session_id = null;
        entry.updated_at = now();
        changed = true;
      }
    }
  });
  return changed;
}
