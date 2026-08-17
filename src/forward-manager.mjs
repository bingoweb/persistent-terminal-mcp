import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';

import { TerminalError } from './errors.mjs';
import { buildForwardSshArgs } from './forward-model.mjs';
import { createStateStore } from './state-store.mjs';

const DEFAULT_STARTUP_GRACE_MS = 300;
const DEFAULT_TERMINATE_GRACE_MS = 500;
const DEFAULT_KILL_GRACE_MS = 200;
const STDERR_TAIL_BYTES = 4096;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validatePid(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    throw new TerminalError('validation_error', 'pid must be a positive integer');
  }
}

function boundedTail(current, chunk, maxBytes = STDERR_TAIL_BYTES) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= maxBytes ? next : next.subarray(next.length - maxBytes);
}

function runExecFile(execFileImpl, executable, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function readProcessIdentity(
  pid,
  { execFileImpl = execFile } = {},
) {
  validatePid(pid);
  let output;
  try {
    const result = await runExecFile(
      execFileImpl,
      'ps',
      ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    output = result.stdout.trim();
  } catch (error) {
    if (error?.code === 1 || error?.code === 'ESRCH') return null;
    throw new TerminalError(
      'local_capability_dependency_error',
      `failed to inspect process identity for pid ${pid}`,
      { cause: error, details: { pid, code: error?.code } },
    );
  }

  if (!output) return null;
  const startedAt = output.slice(0, 24).trim();
  if (!startedAt) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `process identity output was malformed for pid ${pid}`,
      { details: { pid } },
    );
  }
  return {
    started_at: startedAt,
    identity: createHash('sha256').update(output).digest('hex'),
  };
}

function identityMatches(record, identity) {
  return identity !== null
    && identity?.started_at === record.process_started_at
    && identity?.identity === record.process_identity;
}

function startupFailure(exitInfo, stderrTail) {
  return new TerminalError(
    'transport_reconnect_failure',
    `ssh forward exited during startup with status ${exitInfo.code ?? 'null'}`,
    {
      retryable: true,
      details: {
        exit_code: exitInfo.code,
        signal: exitInfo.signal,
        stderr_tail: stderrTail.toString('utf8'),
      },
    },
  );
}

async function waitForSpawnAndStartup(child, waitImpl, startupGraceMs) {
  let exitInfo = null;
  let stderrTail = Buffer.alloc(0);
  child.stderr?.on?.('data', (chunk) => {
    stderrTail = boundedTail(stderrTail, chunk);
  });
  child.on?.('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(new TerminalError(
        'local_capability_dependency_error',
        'failed to start ssh forward process',
        { cause: error, details: { code: error?.code } },
      ));
    };
    const cleanup = () => {
      child.off?.('spawn', onSpawn);
      child.off?.('error', onError);
    };
    child.once?.('spawn', onSpawn);
    child.once?.('error', onError);
  });

  if (exitInfo) throw startupFailure(exitInfo, stderrTail);
  await waitImpl(startupGraceMs);
  if (exitInfo) throw startupFailure(exitInfo, stderrTail);
}

function normalizeCreatedAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  throw new TerminalError('local_capability_dependency_error', 'forward manager clock returned an invalid Date');
}

export function createForwardManager({
  stateStore = createStateStore(),
  spawnImpl = spawn,
  readProcessIdentityImpl = readProcessIdentity,
  killProcessImpl = process.kill.bind(process),
  waitImpl = delay,
  nowImpl = () => new Date(),
  sshExecutable = 'ssh',
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
  terminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
} = {}) {
  async function findRecord(identifier) {
    if (typeof identifier !== 'string' || identifier.length === 0 || identifier.includes('\0')) {
      throw new TerminalError('validation_error', 'forward identifier must be a non-empty string');
    }
    const byId = await stateStore.getForward(identifier);
    if (byId) return byId;
    const records = await stateStore.listForwards();
    return records.find((record) => record.name === identifier) ?? null;
  }

  async function create(definition) {
    if (!definition || typeof definition !== 'object' || typeof definition.forward_id !== 'string') {
      throw new TerminalError('validation_error', 'normalized forward definition is required');
    }
    if (await stateStore.getForward(definition.forward_id)) {
      throw new TerminalError('validation_error', `forward_id already exists: ${definition.forward_id}`);
    }

    const args = buildForwardSshArgs(definition);
    let child;
    try {
      child = spawnImpl(sshExecutable, args, {
        shell: false,
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
    } catch (error) {
      throw new TerminalError(
        'local_capability_dependency_error',
        'failed to spawn ssh forward process',
        { cause: error, details: { executable: sshExecutable } },
      );
    }

    await waitForSpawnAndStartup(child, waitImpl, startupGraceMs);
    validatePid(child.pid);
    const identity = await readProcessIdentityImpl(child.pid);
    if (!identity) {
      throw new TerminalError(
        'transport_reconnect_failure',
        'ssh forward process disappeared before its identity could be recorded',
        { retryable: true, details: { pid: child.pid } },
      );
    }

    const record = Object.freeze({
      ...definition,
      pid: child.pid,
      process_started_at: identity.started_at,
      process_identity: identity.identity,
      created_at: normalizeCreatedAt(nowImpl()),
    });

    try {
      await stateStore.putForward(record);
    } catch (error) {
      const current = await readProcessIdentityImpl(child.pid).catch(() => null);
      if (identityMatches(record, current)) {
        try {
          killProcessImpl(child.pid, 'SIGTERM');
        } catch {
          // State persistence error remains the primary failure.
        }
      }
      throw error;
    }
    return structuredClone(record);
  }

  async function close(identifier) {
    const record = await findRecord(identifier);
    if (!record) {
      throw new TerminalError(
        'stale_session_task_forward_id',
        `unknown forward: ${identifier}`,
        { details: { forward_id: identifier } },
      );
    }

    const before = await readProcessIdentityImpl(record.pid);
    if (!identityMatches(record, before)) {
      throw new TerminalError(
        'stale_session_task_forward_id',
        'recorded forward PID no longer matches the original process identity',
        {
          details: {
            forward_id: record.forward_id,
            pid: record.pid,
            recorded_process_identity: record.process_identity,
          },
        },
      );
    }

    try {
      killProcessImpl(record.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw new TerminalError(
          error?.code === 'EPERM' ? 'permission_privilege_error' : 'local_capability_dependency_error',
          `failed to terminate forward process ${record.pid}`,
          { cause: error, details: { pid: record.pid, code: error?.code } },
        );
      }
    }

    await waitImpl(terminateGraceMs);
    const afterTerm = await readProcessIdentityImpl(record.pid);
    if (identityMatches(record, afterTerm)) {
      const beforeKill = await readProcessIdentityImpl(record.pid);
      if (identityMatches(record, beforeKill)) {
        try {
          killProcessImpl(record.pid, 'SIGKILL');
        } catch (error) {
          if (error?.code !== 'ESRCH') {
            throw new TerminalError(
              error?.code === 'EPERM' ? 'permission_privilege_error' : 'local_capability_dependency_error',
              `failed to kill forward process ${record.pid}`,
              { cause: error, details: { pid: record.pid, code: error?.code } },
            );
          }
        }
        await waitImpl(killGraceMs);
        const afterKill = await readProcessIdentityImpl(record.pid);
        if (identityMatches(record, afterKill)) {
          throw new TerminalError(
            'timeout',
            `forward process ${record.pid} survived SIGKILL grace period`,
            { details: { forward_id: record.forward_id, pid: record.pid } },
          );
        }
      }
    }

    await stateStore.deleteForward(record.forward_id);
    return {
      forward_id: record.forward_id,
      name: record.name ?? null,
      closed: true,
    };
  }

  async function listRecords() {
    return stateStore.listForwards();
  }

  return {
    create,
    close,
    findRecord,
    listRecords,
  };
}
