import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readSshMultiplexConfig } from './config.mjs';
import { TerminalError } from './errors.mjs';
import { resolveTarget } from './target-resolver.mjs';
import { terminalTelemetry } from './telemetry.mjs';

const CONTROL_DIR_RELATIVE = '.ptext-ssh';
const EXEC_MAX_BUFFER = 64 * 1024;
const SAFE_TARGET = /^[^\s\0-][^\s\0]*$/u;
const CONTROL_BASENAME_BYTES = Buffer.byteLength(`ctl_${'0'.repeat(32)}`, 'utf8');
const MAX_CONTROL_PATH_BYTES = 80;

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TerminalError('validation_error', 'SSH multiplex target must be a non-empty string');
  }
  const normalized = target.trim();
  if (!SAFE_TARGET.test(normalized)) {
    throw new TerminalError('validation_error', 'SSH multiplex target must be a safe OpenSSH host or alias');
  }
  return normalized;
}

function runExecFile(execFileImpl, executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function identityMaterial(target, resolved) {
  return JSON.stringify({
    alias: target,
    hostname: resolved?.hostname ?? target,
    user: resolved?.user ?? '',
    port: resolved?.port ?? 22,
    proxy_jump: resolved?.proxyJump ?? '',
  });
}

function identityHash(target, resolved) {
  return createHash('sha256').update(identityMaterial(target, resolved)).digest('hex');
}

function safeDuration(now, startedAt) {
  const endedAt = Number(now());
  return Number.isFinite(endedAt) && Number.isFinite(startedAt)
    ? Math.max(0, endedAt - startedAt)
    : 0;
}

function isAuthenticationFailure(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  return /host key verification failed|permission denied|authentication failed|no supported authentication methods/iu
    .test(text);
}

function requiredMasterError(error, targetHash) {
  if (isAuthenticationFailure(error)) {
    return new TerminalError(
      'host_key_authentication_error',
      'OpenSSH master could not be established because host-key or authentication validation failed',
      { retryable: false, cause: error, details: { target_hash: targetHash.slice(0, 16) } },
    );
  }
  return new TerminalError(
    'transport_reconnect_failure',
    'SSH multiplex mode is required but a reusable master could not be established',
    {
      retryable: true,
      cause: error,
      details: { target_hash: targetHash.slice(0, 16) },
    },
  );
}

function projectedControlPathBytes(root) {
  return Buffer.byteLength(root, 'utf8') + 1 + CONTROL_BASENAME_BYTES;
}

function validateControlRootLength(root) {
  if (projectedControlPathBytes(root) > MAX_CONTROL_PATH_BYTES) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'SSH multiplex control path root is too long for a portable Unix-domain socket path',
      {
        details: {
          max_control_path_bytes: MAX_CONTROL_PATH_BYTES,
          projected_control_path_bytes: projectedControlPathBytes(root),
        },
      },
    );
  }
  return root;
}

function chooseControlRoot({ homeDir, controlDir, uid, pid }) {
  if (controlDir !== null) return validateControlRootLength(controlDir);
  const homeCandidate = path.join(homeDir, CONTROL_DIR_RELATIVE);
  if (projectedControlPathBytes(homeCandidate) <= MAX_CONTROL_PATH_BYTES) return homeCandidate;
  const identity = Number.isInteger(uid) && uid >= 0 ? String(uid) : 'user';
  return validateControlRootLength(path.join('/tmp', `ptext-ssh-${identity}-${pid}`));
}

export function createSshMultiplexManager({
  env = process.env,
  homeDir = process.env.HOME,
  execFileImpl = execFile,
  fsImpl = fs,
  resolveTargetImpl = resolveTarget,
  now = Date.now,
  telemetry = terminalTelemetry,
  controlDir = null,
  getUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
  pid = process.pid,
} = {}) {
  const config = readSshMultiplexConfig(env);
  const baseHome = typeof homeDir === 'string' && homeDir.length > 0 ? homeDir : null;
  if (config.mode !== 'off' && !baseHome && controlDir === null) {
    throw new TypeError('homeDir must be available when SSH multiplexing is enabled');
  }
  if (typeof execFileImpl !== 'function') throw new TypeError('execFileImpl must be a function');
  if (typeof resolveTargetImpl !== 'function') throw new TypeError('resolveTargetImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const ownerUid = getUid();
  const controlRoot = config.mode === 'off'
    ? null
    : chooseControlRoot({ homeDir: baseHome, controlDir, uid: ownerUid, pid });
  const masters = new Map();
  const identities = new Map();
  const pending = new Map();
  let directoryPromise = null;

  async function ensureControlDirectory() {
    if (directoryPromise) return directoryPromise;
    directoryPromise = (async () => {
      await fsImpl.mkdir(controlRoot, { recursive: true, mode: 0o700 });
      const stat = await fsImpl.lstat(controlRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink?.()) {
        throw new TerminalError(
          'local_capability_dependency_error',
          'SSH multiplex control path root must be a real directory',
        );
      }
      if (Number.isInteger(ownerUid) && Number.isInteger(stat.uid) && stat.uid !== ownerUid) {
        throw new TerminalError(
          'local_capability_dependency_error',
          'SSH multiplex control path root is not owned by the current user',
        );
      }
      await fsImpl.chmod(controlRoot, 0o700);
    })().catch((error) => {
      directoryPromise = null;
      if (error instanceof TerminalError) throw error;
      throw new TerminalError(
        'local_capability_dependency_error',
        'Unable to prepare the private SSH multiplex control directory',
        { cause: error },
      );
    });
    return directoryPromise;
  }

  async function resolvedIdentity(target) {
    if (identities.has(target)) return identities.get(target);
    const resolved = await resolveTargetImpl(target);
    const hash = identityHash(target, resolved);
    const value = Object.freeze({ resolved, hash });
    identities.set(target, value);
    return value;
  }

  function recordArgs(controlPath) {
    return ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`];
  }

  async function checkMaster(record) {
    try {
      await runExecFile(
        execFileImpl,
        'ssh',
        ['-S', record.controlPath, '-O', 'check', record.target],
        {
          encoding: 'utf8',
          maxBuffer: EXEC_MAX_BUFFER,
          env: { ...process.env, LC_ALL: 'C' },
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  async function pathExists(filePath) {
    try {
      await fsImpl.lstat(filePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function closeRecord(record) {
    try {
      await runExecFile(
        execFileImpl,
        'ssh',
        ['-S', record.controlPath, '-O', 'exit', record.target],
        {
          encoding: 'utf8',
          maxBuffer: EXEC_MAX_BUFFER,
          env: { ...process.env, LC_ALL: 'C' },
        },
      );
    } catch {
      // A dead/stale owned master is cleaned up by removing only our hashed path.
    }
    await fsImpl.rm(record.controlPath, { force: true }).catch(() => {});
    masters.delete(record.target);
  }

  async function evictOldestIfNeeded(exceptTarget = null) {
    if (masters.size < config.maxTargets) return;
    const candidates = [...masters.values()]
      .filter((record) => record.target !== exceptTarget)
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    const oldest = candidates[0];
    if (oldest) await closeRecord(oldest);
  }

  async function createMaster(record) {
    const startedAt = Number(now());
    try {
      await runExecFile(
        execFileImpl,
        'ssh',
        [
          '-MNf',
          '-o', 'BatchMode=yes',
          '-o', 'ControlMaster=yes',
          '-o', `ControlPath=${record.controlPath}`,
          '-o', `ControlPersist=${config.controlPersistSeconds}`,
          record.target,
        ],
        {
          encoding: 'utf8',
          maxBuffer: EXEC_MAX_BUFFER,
          env: { ...process.env, LC_ALL: 'C' },
        },
      );
      if (!await checkMaster(record)) {
        throw new Error('OpenSSH master process did not pass post-start check');
      }
    } finally {
      telemetry?.recordTiming?.('ssh_handshake', safeDuration(now, startedAt));
    }
  }

  async function acquireCore(target) {
    await ensureControlDirectory();
    const identity = await resolvedIdentity(target);
    const controlPath = path.join(controlRoot, `ctl_${identity.hash.slice(0, 32)}`);
    let record = masters.get(target) ?? {
      target,
      targetHash: identity.hash,
      controlPath,
      lastUsedMs: Number(now()),
    };

    if (await checkMaster(record)) {
      record.lastUsedMs = Number(now());
      masters.set(target, record);
      telemetry?.incrementCounter?.('multiplex_hit');
      return Object.freeze({ args: Object.freeze(recordArgs(controlPath)), state: 'hit' });
    }

    const staleOwnedPath = await pathExists(controlPath);
    if (masters.has(target)) masters.delete(target);
    if (staleOwnedPath) await fsImpl.rm(controlPath, { force: true });
    telemetry?.incrementCounter?.('multiplex_miss');

    await evictOldestIfNeeded(target);
    try {
      await createMaster(record);
      record = {
        ...record,
        lastUsedMs: Number(now()),
      };
      masters.set(target, record);
      const state = staleOwnedPath ? 'stale_recovered' : 'miss';
      if (staleOwnedPath) telemetry?.incrementCounter?.('multiplex_stale_recovered');
      return Object.freeze({ args: Object.freeze(recordArgs(controlPath)), state });
    } catch (error) {
      await fsImpl.rm(controlPath, { force: true }).catch(() => {});
      if (config.mode === 'required') throw requiredMasterError(error, identity.hash);
      telemetry?.incrementCounter?.('multiplex_fallback');
      return Object.freeze({ args: Object.freeze([]), state: 'fallback' });
    }
  }

  async function acquire(targetInput) {
    const target = validateTarget(targetInput);
    if (config.mode === 'off') return Object.freeze({ args: Object.freeze([]), state: 'off' });

    const startedAt = Number(now());
    try {
      let operation = pending.get(target);
      if (!operation) {
        operation = acquireCore(target);
        pending.set(target, operation);
        operation.finally(() => {
          if (pending.get(target) === operation) pending.delete(target);
        }).catch(() => {});
      }
      return await operation;
    } finally {
      telemetry?.recordTiming?.('ssh_master_acquire', safeDuration(now, startedAt));
    }
  }

  async function closeIdle() {
    for (const record of [...masters.values()]) {
      if (!await checkMaster(record)) {
        await fsImpl.rm(record.controlPath, { force: true }).catch(() => {});
        masters.delete(record.target);
      }
    }
    return snapshot();
  }

  async function closeAll() {
    await Promise.all([...masters.values()].map((record) => closeRecord(record)));
    return snapshot();
  }

  function snapshot() {
    return Object.freeze({
      mode: config.mode,
      active_masters: masters.size,
      max_targets: config.maxTargets,
      control_persist_seconds: config.controlPersistSeconds,
      masters: Object.freeze([...masters.values()]
        .sort((a, b) => a.lastUsedMs - b.lastUsedMs)
        .map((record) => Object.freeze({
          target_hash: record.targetHash.slice(0, 16),
          last_used_ms: record.lastUsedMs,
        }))),
    });
  }

  function inspect(targetInput) {
    const target = validateTarget(targetInput);
    if (config.mode === 'off') {
      return Object.freeze({
        mode: 'off',
        state: 'off',
        active: false,
        target_hash: null,
      });
    }
    const record = masters.get(target) ?? null;
    const identity = identities.get(target) ?? null;
    return Object.freeze({
      mode: config.mode,
      state: record ? 'active' : 'inactive',
      active: Boolean(record),
      target_hash: (record?.targetHash ?? identity?.hash)?.slice(0, 16) ?? null,
    });
  }

  return Object.freeze({ acquire, snapshot, inspect, closeIdle, closeAll });
}

