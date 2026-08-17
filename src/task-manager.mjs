import { randomBytes } from 'node:crypto';

import { TerminalError } from './errors.mjs';
import { createStateStore } from './state-store.mjs';
import { transitionTask } from './task-model.mjs';
import { resolveTarget } from './target-resolver.mjs';
import { PtyUpstreamClient } from './upstream-pty.mjs';

const defaultStateStore = createStateStore();
const defaultUpstreamClient = new PtyUpstreamClient();
const DEFAULT_OUTPUT_BYTES = 32768;
const MAX_OUTPUT_BYTES = 262144;
const MAX_WAIT_SECONDS = 600;
const MAX_CANCEL_WAIT_SECONDS = 30;
const MAX_BUFFER_DRAIN_READS = 16;

function validateString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TerminalError('validation_error', `${field} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TerminalError('validation_error', `${field} must not contain NUL bytes`);
  }
  return value;
}

function randomHex(randomBytesImpl, size, field) {
  const value = randomBytesImpl(size);
  if (!Buffer.isBuffer(value) || value.length !== size) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `${field} entropy generator returned invalid bytes`,
    );
  }
  return value.toString('hex');
}

function parseToolJson(result, toolName) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new TerminalError(
      'missing_remote_capability',
      `${toolName} did not return JSON content`,
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

function assertToolSuccess(result, toolName) {
  if (result?.isError !== true) return parseToolJson(result, toolName);
  const parsed = parseToolJson(result, toolName);
  const detail = typeof parsed?.message === 'string' && parsed.message.length > 0
    ? `: ${parsed.message}`
    : '';
  throw new TerminalError(
    'local_capability_dependency_error',
    `${toolName} failed${detail}`,
  );
}

function sessionIds(result) {
  const parsed = assertToolSuccess(result, 'create_ssh_session');
  if (typeof parsed?.session_id !== 'string' || parsed.session_id.length === 0) {
    throw new TerminalError(
      'missing_remote_capability',
      'create_ssh_session did not return session_id',
    );
  }
  const remoteSessionId = typeof parsed.remote_session_id === 'string' && parsed.remote_session_id.length > 0
    ? parsed.remote_session_id
    : null;
  return { sessionId: parsed.session_id, remoteSessionId };
}

function remoteSessionId(entry) {
  const value = entry?.id ?? entry?.session_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function listRemoteSessionIds(upstreamClient, resolved) {
  const response = await upstreamClient.callTool('list_remote_sessions', {
    host: resolved.alias,
    user: resolved.user,
  });
  const parsed = assertToolSuccess(response, 'list_remote_sessions');
  if (!Array.isArray(parsed)) {
    throw new TerminalError(
      'missing_remote_capability',
      'list_remote_sessions did not return an array',
    );
  }
  return new Set(
    parsed
      .filter((entry) => entry?.is_alive !== false)
      .map(remoteSessionId)
      .filter(Boolean),
  );
}

function buildTaskWrapper(command, marker) {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  return [
    `__ptext_cmd_b64='${encoded}'`,
    '__ptext_cmd="$(printf \'%s\' "$__ptext_cmd_b64" | base64 -d)"',
    'bash -lc "$__ptext_cmd"',
    '__ptext_exit=$?',
    `printf '\\n%s%s__\\n' '${marker}' "$__ptext_exit"`,
  ].join('; ');
}

function validateTaskId(taskId) {
  return validateString(taskId, 'task_id');
}

function validateOutputBytes(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_OUTPUT_BYTES) {
    throw new TerminalError(
      'validation_error',
      `max_bytes must be an integer between 1 and ${MAX_OUTPUT_BYTES}`,
    );
  }
  return value;
}

function validateWaitSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_WAIT_SECONDS) {
    throw new TerminalError(
      'validation_error',
      `timeout must be a finite number between 0 and ${MAX_WAIT_SECONDS}`,
    );
  }
  return value;
}

function validateCancelWaitSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CANCEL_WAIT_SECONDS) {
    throw new TerminalError(
      'validation_error',
      `cancel timeout must be a finite number between 0 and ${MAX_CANCEL_WAIT_SECONDS}`,
    );
  }
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function validateMarker(marker) {
  if (typeof marker !== 'string' || !/^__PTEXT_TASK_[0-9a-f]{48}_EXIT=$/u.test(marker)) {
    throw new TerminalError('local_capability_dependency_error', 'stored task marker is malformed');
  }
  return marker;
}

export function completionPattern(marker) {
  return `^${escapeRegex(validateMarker(marker))}[0-9]{1,3}__$`;
}

function parseCompletionLine(marker, line) {
  if (typeof line !== 'string') return null;
  const match = new RegExp(completionPattern(marker), 'u').exec(line.replace(/\r$/u, ''));
  if (!match) return null;
  const prefixLength = marker.length;
  const exitCode = Number.parseInt(line.slice(prefixLength, line.lastIndexOf('__')), 10);
  return Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null;
}

function completionFromText(task, text) {
  for (const line of text.split(/\n/u)) {
    const exitCode = parseCompletionLine(task.marker, line);
    if (exitCode !== null) return exitCode;
  }
  return null;
}

function markerFragment(task, text) {
  const lastNewline = text.lastIndexOf('\n');
  const candidate = text.slice(lastNewline + 1).replace(/\r$/u, '');
  if (!candidate) return '';
  if (task.marker.startsWith(candidate)) return candidate;
  if (!candidate.startsWith(task.marker)) return '';
  const suffix = candidate.slice(task.marker.length);
  if (/^[0-9]{0,3}_?$/u.test(suffix)) return candidate;
  return '';
}

function transitionWithExit(task, exitCode) {
  if (!['queued', 'running'].includes(task.state)) return task;
  const running = task.state === 'queued'
    ? transitionTask(task, { type: 'started' })
    : task;
  return transitionTask(running, { type: 'exited', exit_code: exitCode });
}

async function loadTask(taskId, stateStore) {
  const validated = validateTaskId(taskId);
  const task = await stateStore.getTask(validated);
  if (!task) {
    throw new TerminalError(
      'stale_session_task_forward_id',
      `unknown task: ${validated}`,
      { details: { task_id: validated } },
    );
  }
  return task;
}

async function localSessionAlive(upstreamClient, sessionId) {
  try {
    const response = await upstreamClient.callTool('get_session_state', { session_id: sessionId });
    if (response?.isError === true) return false;
    const parsed = parseToolJson(response, 'get_session_state');
    return parsed?.is_alive !== false;
  } catch {
    return false;
  }
}

async function ensureTaskSession(task, {
  stateStore,
  upstreamClient,
  resolveTargetImpl,
}) {
  if (task.state === 'lost') return { task, session_id: null };
  const resolved = await resolveTargetImpl(task.target);
  if (!resolved?.alias || !resolved?.user) {
    throw new TerminalError(
      'target_resolution_error',
      `OpenSSH target ${task.target} did not resolve alias and user`,
    );
  }

  const remoteIds = await listRemoteSessionIds(upstreamClient, resolved);
  if (!remoteIds.has(task.remote_session_id)) {
    if (['queued', 'running'].includes(task.state)) {
      const lost = transitionTask(task, { type: 'lost' });
      await stateStore.putTask(lost);
      return { task: lost, session_id: null };
    }
    return { task, session_id: null };
  }

  if (await localSessionAlive(upstreamClient, task.session_id)) {
    return { task, session_id: task.session_id };
  }

  const attached = await upstreamClient.callTool('create_ssh_session', {
    host: resolved.alias,
    user: resolved.user,
    persistent: true,
    session_id: task.remote_session_id,
  });
  const parsed = assertToolSuccess(attached, 'create_ssh_session');
  if (typeof parsed?.session_id !== 'string' || parsed.session_id.length === 0) {
    throw new TerminalError(
      'missing_remote_capability',
      'reattach create_ssh_session did not return session_id',
    );
  }
  const recovered = Object.freeze({ ...task, session_id: parsed.session_id });
  await stateStore.putTask(recovered);
  return { task: recovered, session_id: recovered.session_id };
}

async function applyOutputChunk(task, response, stateStore) {
  if (!response || typeof response !== 'object') {
    throw new TerminalError('missing_remote_capability', 'read_output returned invalid task output');
  }
  const output = typeof response.output === 'string' ? response.output : '';
  const cursor = response.cursor;
  if (!Number.isInteger(cursor) || cursor < task.cursor) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'read_output returned a regressing or invalid cursor',
      { details: { task_id: task.task_id, previous_cursor: task.cursor, cursor } },
    );
  }

  const combined = `${task.marker_fragment ?? ''}${output}`;
  const exitCode = completionFromText(task, combined);
  let next = exitCode === null ? task : transitionWithExit(task, exitCode);
  next = Object.freeze({
    ...next,
    cursor,
    marker_fragment: exitCode === null ? markerFragment(task, combined) : '',
  });
  await stateStore.putTask(next);
  return {
    task: next,
    output,
    cursor,
    has_more: response.has_more === true,
    is_truncated: response.is_truncated === true,
  };
}

export async function startTask(
  { target, command } = {},
  {
    stateStore = defaultStateStore,
    upstreamClient = defaultUpstreamClient,
    resolveTargetImpl = resolveTarget,
    randomBytesImpl = randomBytes,
    now = () => new Date().toISOString(),
  } = {},
) {
  const validatedTarget = validateString(target, 'target');
  const validatedCommand = validateString(command, 'command');
  const resolved = await resolveTargetImpl(validatedTarget);
  if (!resolved?.alias || !resolved?.user) {
    throw new TerminalError(
      'target_resolution_error',
      `OpenSSH target ${validatedTarget} did not resolve alias and user`,
    );
  }

  const remoteIdsBefore = await listRemoteSessionIds(upstreamClient, resolved);

  const taskId = `task_${randomHex(randomBytesImpl, 12, 'task id')}`;
  const marker = `__PTEXT_TASK_${randomHex(randomBytesImpl, 24, 'task marker')}_EXIT=`;
  const created = await upstreamClient.callTool('create_ssh_session', {
    host: resolved.alias,
    user: resolved.user,
    persistent: true,
    command: '/bin/bash',
  });
  let session;
  try {
    session = sessionIds(created);
    if (!session.remoteSessionId) {
      const remoteIdsAfter = await listRemoteSessionIds(upstreamClient, resolved);
      const createdRemoteIds = [...remoteIdsAfter].filter((id) => !remoteIdsBefore.has(id));
      if (createdRemoteIds.length !== 1) {
        throw new TerminalError(
          'missing_remote_capability',
          'could not identify exactly one new persistent remote session for task',
          {
            details: {
              target: validatedTarget,
              new_remote_session_count: createdRemoteIds.length,
            },
          },
        );
      }
      session.remoteSessionId = createdRemoteIds[0];
    }
  } catch (error) {
    const parsed = (() => {
      try {
        return parseToolJson(created, 'create_ssh_session');
      } catch {
        return null;
      }
    })();
    if (typeof parsed?.session_id === 'string') {
      await upstreamClient.callTool('close_session', { session_id: parsed.session_id }).catch(() => {});
    }
    throw error;
  }

  const queued = Object.freeze({
    task_id: taskId,
    target: validatedTarget,
    session_id: session.sessionId,
    remote_session_id: session.remoteSessionId,
    command: validatedCommand,
    state: 'queued',
    started_at: now(),
    cursor: 0,
    marker,
  });

  try {
    await stateStore.putTask(queued);
  } catch (error) {
    await upstreamClient.callTool('close_session', { session_id: session.sessionId }).catch(() => {});
    throw error;
  }

  try {
    const sent = await upstreamClient.callTool('send_input', {
      session_id: session.sessionId,
      input: buildTaskWrapper(validatedCommand, marker),
    });
    assertToolSuccess(sent, 'send_input');
    const running = transitionTask(queued, { type: 'started' });
    await stateStore.putTask(running);
    return structuredClone(running);
  } catch (error) {
    await upstreamClient.callTool('close_session', { session_id: session.sessionId }).catch(() => {});
    await stateStore.deleteTask(taskId).catch(() => {});
    throw error;
  }
}

export async function getTaskStatus(
  taskId,
  {
    stateStore = defaultStateStore,
    upstreamClient = defaultUpstreamClient,
    resolveTargetImpl = resolveTarget,
  } = {},
) {
  const task = await loadTask(taskId, stateStore);
  if (!['queued', 'running'].includes(task.state)) return structuredClone(task);
  const ensured = await ensureTaskSession(task, {
    stateStore,
    upstreamClient,
    resolveTargetImpl,
  });
  return structuredClone(ensured.task);
}

export async function readTaskOutput(
  taskId,
  {
    stateStore = defaultStateStore,
    upstreamClient = defaultUpstreamClient,
    resolveTargetImpl = resolveTarget,
    maxBytes = DEFAULT_OUTPUT_BYTES,
  } = {},
) {
  const boundedBytes = validateOutputBytes(maxBytes);
  const task = await loadTask(taskId, stateStore);
  const ensured = await ensureTaskSession(task, {
    stateStore,
    upstreamClient,
    resolveTargetImpl,
  });
  if (!ensured.session_id) {
    return {
      task: structuredClone(ensured.task),
      output: '',
      cursor: ensured.task.cursor,
      has_more: false,
      is_truncated: false,
    };
  }

  const response = assertToolSuccess(await upstreamClient.callTool('read_output', {
    session_id: ensured.session_id,
    since_cursor: ensured.task.cursor,
    max_bytes: boundedBytes,
  }), 'read_output');
  return applyOutputChunk(ensured.task, response, stateStore);
}

export async function waitForTask(
  taskId,
  {
    stateStore = defaultStateStore,
    upstreamClient = defaultUpstreamClient,
    resolveTargetImpl = resolveTarget,
    timeout = 30,
  } = {},
) {
  const boundedTimeout = validateWaitSeconds(timeout);
  let task = await loadTask(taskId, stateStore);
  if (!['queued', 'running'].includes(task.state)) {
    return { task: structuredClone(task), timed_out: false };
  }

  for (let index = 0; index < MAX_BUFFER_DRAIN_READS; index += 1) {
    const read = await readTaskOutput(task.task_id, {
      stateStore,
      upstreamClient,
      resolveTargetImpl,
      maxBytes: MAX_OUTPUT_BYTES,
    });
    task = read.task;
    if (!['queued', 'running'].includes(task.state)) {
      return { task: structuredClone(task), timed_out: false };
    }
    if (!read.has_more) break;
  }

  const ensured = await ensureTaskSession(task, {
    stateStore,
    upstreamClient,
    resolveTargetImpl,
  });
  task = ensured.task;
  if (!ensured.session_id || !['queued', 'running'].includes(task.state)) {
    return { task: structuredClone(task), timed_out: false };
  }

  const waited = assertToolSuccess(await upstreamClient.callTool('read_output', {
    session_id: ensured.session_id,
    wait_for: completionPattern(task.marker),
    timeout: boundedTimeout,
    tail_lines: 0,
  }), 'read_output');

  if (waited?.matched === true) {
    const exitCode = parseCompletionLine(task.marker, waited.match_line);
    if (exitCode === null) {
      throw new TerminalError(
        'local_capability_dependency_error',
        'read_output wait_for matched an invalid task completion line',
        { details: { task_id: task.task_id } },
      );
    }
    task = transitionWithExit(task, exitCode);
    await stateStore.putTask(task);
    return { task: structuredClone(task), timed_out: false };
  }

  return {
    task: structuredClone(task),
    timed_out: waited?.timed_out === true,
  };
}

export async function cancelTask(
  taskId,
  {
    stateStore = defaultStateStore,
    upstreamClient = defaultUpstreamClient,
    resolveTargetImpl = resolveTarget,
    timeout = 5,
    terminateSession = false,
  } = {},
) {
  const boundedTimeout = validateCancelWaitSeconds(timeout);
  if (typeof terminateSession !== 'boolean') {
    throw new TerminalError('validation_error', 'terminateSession must be a boolean');
  }

  let task = await loadTask(taskId, stateStore);
  if (!['queued', 'running'].includes(task.state)) {
    return { task: structuredClone(task), terminated_session: false };
  }

  for (let index = 0; index < MAX_BUFFER_DRAIN_READS; index += 1) {
    const read = await readTaskOutput(task.task_id, {
      stateStore,
      upstreamClient,
      resolveTargetImpl,
      maxBytes: MAX_OUTPUT_BYTES,
    });
    task = read.task;
    if (!['queued', 'running'].includes(task.state)) {
      return { task: structuredClone(task), terminated_session: false };
    }
    if (!read.has_more) break;
  }

  const ensured = await ensureTaskSession(task, {
    stateStore,
    upstreamClient,
    resolveTargetImpl,
  });
  task = ensured.task;
  if (!ensured.session_id || !['queued', 'running'].includes(task.state)) {
    return { task: structuredClone(task), terminated_session: false };
  }

  assertToolSuccess(await upstreamClient.callTool('send_control', {
    session_id: ensured.session_id,
    key: 'ctrl+c',
  }), 'send_control');

  const waited = assertToolSuccess(await upstreamClient.callTool('read_output', {
    session_id: ensured.session_id,
    wait_for: completionPattern(task.marker),
    timeout: boundedTimeout,
    tail_lines: 0,
  }), 'read_output');

  if (waited?.matched === true) {
    if (parseCompletionLine(task.marker, waited.match_line) === null) {
      throw new TerminalError(
        'local_capability_dependency_error',
        'cancellation wait matched an invalid task completion line',
        { details: { task_id: task.task_id } },
      );
    }
  } else if (waited?.timed_out === true && !terminateSession) {
    throw new TerminalError(
      'timeout',
      'task did not reach its completion marker after Ctrl-C',
      {
        retryable: true,
        details: { task_id: task.task_id, timeout_seconds: boundedTimeout },
      },
    );
  } else if (waited?.matched !== true && !terminateSession) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'task cancellation wait ended without a completion marker',
      { details: { task_id: task.task_id } },
    );
  }

  let terminatedSession = false;
  if (terminateSession && waited?.matched !== true) {
    assertToolSuccess(await upstreamClient.callTool('close_session', {
      session_id: ensured.session_id,
    }), 'close_session');
    terminatedSession = true;
  }

  const cancelled = transitionTask(task, { type: 'cancelled' });
  await stateStore.putTask(cancelled);
  return {
    task: structuredClone(cancelled),
    terminated_session: terminatedSession,
  };
}

export async function listTasks({ stateStore = defaultStateStore } = {}) {
  return stateStore.listTasks();
}
