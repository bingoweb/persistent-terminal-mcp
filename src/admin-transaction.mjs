import { randomUUID } from 'node:crypto';

import { TerminalError, normalizeFailure } from './errors.mjs';
import { validateSystemdAction, validateSystemdUnit } from './systemd-core.mjs';

export const ADMIN_TRANSACTION_STATES = Object.freeze([
  'committed',
  'precheck_failed',
  'snapshot_failed',
  'mutation_failed',
  'health_failed',
  'rolled_back',
  'rollback_failed',
]);

const MAX_HEALTH_CHECKS = 8;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_COMMAND_CHARS = 16 * 1024;
const MAX_REGEX_CHARS = 256;
const SAFE_TARGET = /^[^\s\0-][^\s\0]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVERSIBLE_SYSTEMD_ACTIONS = new Set([
  'start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart',
  'enable', 'disable', 'reenable',
]);

function publicFailure(error) {
  const normalized = normalizeFailure(error);
  return Object.freeze({
    category: normalized.category,
    message: normalized.message,
    retryable: normalized.retryable,
  });
}

function validation(message) {
  throw new TerminalError('validation_error', message);
}

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') validation('transaction target must be a non-empty OpenSSH host or alias');
  const value = target.trim();
  if (!SAFE_TARGET.test(value)) validation('transaction target must be a safe OpenSSH host or alias');
  return value;
}

function validatePrivilege(privilege) {
  const value = privilege ?? 'auto';
  if (!['auto', 'user', 'root'].includes(value)) validation('transaction privilege must be auto, user or root');
  return value;
}

function validateCommand(command, label) {
  if (typeof command !== 'string' || command.trim() === '' || command.includes('\0')) {
    validation(`${label} command must be non-empty text without NUL bytes`);
  }
  if (command.length > MAX_COMMAND_CHARS) validation(`${label} command exceeds the transaction bound`);
  return command;
}

function validateExitCode(value, label) {
  const code = value ?? 0;
  if (!Number.isInteger(code) || code < 0 || code > 255) validation(`${label} expected_exit_code must be an integer between 0 and 255`);
  return code;
}

function validatePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) validation('transaction mutation path must be non-empty text without NUL bytes');
  return value;
}

function validateExpectedSha(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SHA256.test(value)) validation('transaction expected_sha256 must be a lowercase SHA-256 value');
  return value;
}

function validateText(text) {
  if (typeof text !== 'string' || text.includes('\0')) validation('transaction mutation text must be UTF-8 text without NUL bytes');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) validation('transaction mutation text exceeds the 1 MiB rollback bound');
  return text;
}

function validateHunks(hunks) {
  if (!Array.isArray(hunks) || hunks.length < 1 || hunks.length > 128) validation('transaction remote_patch requires 1..128 hunks');
  return hunks.map((hunk, index) => {
    if (hunk === null || typeof hunk !== 'object' || Array.isArray(hunk)) validation(`transaction hunk ${index} must be an object`);
    if (typeof hunk.old !== 'string' || typeof hunk.new !== 'string') validation(`transaction hunk ${index} old/new must be text`);
    if (hunk.old.includes('\0') || hunk.new.includes('\0')) validation(`transaction hunk ${index} must not contain NUL bytes`);
    const expectedCount = hunk.expected_count ?? 1;
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 10000) validation(`transaction hunk ${index} expected_count is invalid`);
    return Object.freeze({ old: hunk.old, new: hunk.new, expected_count: expectedCount });
  });
}

function unsafeRegex(pattern) {
  return /\\[1-9]/u.test(pattern) || /\([^)]*[+*{][^)]*\)[+*{]/u.test(pattern);
}

function validateRegex(pattern) {
  if (pattern === undefined) return null;
  if (typeof pattern !== 'string' || pattern.length > MAX_REGEX_CHARS) validation('health stdout_regex exceeds the transaction regex bound');
  if (unsafeRegex(pattern)) validation('health stdout_regex uses a transaction-unsafe nested or backreference pattern');
  try {
    return Object.freeze({ source: pattern, compiled: new RegExp(pattern, 'u') });
  } catch (error) {
    throw new TerminalError('validation_error', 'health stdout_regex is invalid', { cause: error });
  }
}

function validateMutation(mutation) {
  if (mutation === null || typeof mutation !== 'object' || Array.isArray(mutation)) validation('transaction mutation must be one object');
  if (mutation.type === 'remote_write') {
    return Object.freeze({
      type: 'remote_write', path: validatePath(mutation.path), text: validateText(mutation.text),
      expected_sha256: validateExpectedSha(mutation.expected_sha256),
    });
  }
  if (mutation.type === 'remote_patch') {
    return Object.freeze({
      type: 'remote_patch', path: validatePath(mutation.path),
      expected_sha256: validateExpectedSha(mutation.expected_sha256),
      hunks: Object.freeze(validateHunks(mutation.hunks)),
    });
  }
  if (mutation.type === 'systemd_action') {
    const unit = validateSystemdUnit(mutation.unit);
    const action = validateSystemdAction(mutation.action);
    if (!REVERSIBLE_SYSTEMD_ACTIONS.has(action)) validation(`transaction systemd mutation ${action} is not safely rollback-reversible`);
    return Object.freeze({ type: 'systemd_action', unit, action });
  }
  validation('transaction mutation type must be remote_write, remote_patch or systemd_action');
}

function validateHealthCheck(check, index) {
  if (check === null || typeof check !== 'object' || Array.isArray(check)) validation(`health check ${index} must be an object`);
  if (check.type === 'command') {
    return Object.freeze({
      type: 'command', command: validateCommand(check.command, `health check ${index}`),
      expected_exit_code: validateExitCode(check.expected_exit_code, `health check ${index}`),
      stdout_regex: validateRegex(check.stdout_regex),
    });
  }
  if (check.type === 'systemd_unit') {
    const activeState = check.active_state ?? null;
    const subState = check.sub_state ?? null;
    if (activeState !== null && (typeof activeState !== 'string' || activeState === '')) validation(`health check ${index} active_state must be non-empty text`);
    if (subState !== null && (typeof subState !== 'string' || subState === '')) validation(`health check ${index} sub_state must be non-empty text`);
    if (activeState === null && subState === null) validation(`health check ${index} systemd unit requires active_state or sub_state`);
    return Object.freeze({ type: 'systemd_unit', unit: validateSystemdUnit(check.unit), active_state: activeState, sub_state: subState });
  }
  validation(`health check ${index} type must be command or systemd_unit`);
}

export function validateAdminTransactionRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) validation('admin transaction request must be an object');
  const rollbackOnFailure = request.rollback_on_failure ?? true;
  if (typeof rollbackOnFailure !== 'boolean') validation('transaction rollback_on_failure must be a boolean');
  if (!Array.isArray(request.health_checks) || request.health_checks.length < 1 || request.health_checks.length > MAX_HEALTH_CHECKS) {
    validation(`transaction health_checks must contain 1..${MAX_HEALTH_CHECKS} checks`);
  }
  const precheck = request.precheck === undefined ? null : (() => {
    if (request.precheck === null || typeof request.precheck !== 'object' || Array.isArray(request.precheck)) validation('transaction precheck must be an object');
    return Object.freeze({
      command: validateCommand(request.precheck.command, 'precheck'),
      expected_exit_code: validateExitCode(request.precheck.expected_exit_code, 'precheck'),
    });
  })();
  return Object.freeze({
    target: validateTarget(request.target),
    privilege: validatePrivilege(request.privilege),
    precheck,
    mutation: validateMutation(request.mutation),
    health_checks: Object.freeze(request.health_checks.map(validateHealthCheck)),
    rollback_on_failure: rollbackOnFailure,
  });
}

function baseResult(transactionId, target) {
  return {
    transaction_id: transactionId, target, state: null,
    precheck: { configured: false, passed: true, exit_code: null },
    mutation: null,
    health: { passed: false, checks: [] },
    rollback: { attempted: false, succeeded: false, verified: false, failure: null },
  };
}

function freezeResult(result) {
  result.precheck = Object.freeze(result.precheck);
  result.mutation = result.mutation === null ? null : Object.freeze(result.mutation);
  result.health = Object.freeze({ ...result.health, checks: Object.freeze(result.health.checks.map((check) => Object.freeze(check))) });
  result.rollback = Object.freeze(result.rollback);
  return Object.freeze(result);
}

async function runCommandCheck(check, target, remoteExecImpl) {
  try {
    const executed = await remoteExecImpl({ target, command: check.command, timeout_ms: 15_000, max_output_bytes: 32 * 1024 });
    const normalizedStdout = String(executed.stdout ?? '').replace(/\r?\n$/u, '');
    const regexMatched = check.stdout_regex === null ? null : check.stdout_regex.compiled.test(normalizedStdout);
    return {
      type: 'command',
      passed: executed.exit_code === check.expected_exit_code && !executed.timed_out && !executed.truncated && regexMatched !== false,
      exit_code: executed.exit_code,
      stdout_regex_matched: regexMatched,
    };
  } catch (error) {
    return { type: 'command', passed: false, exit_code: null, stdout_regex_matched: check.stdout_regex === null ? null : false, failure: publicFailure(error) };
  }
}

async function runSystemdCheck(check, target, systemdStatusImpl) {
  try {
    const status = await systemdStatusImpl({ target, unit: check.unit });
    return {
      type: 'systemd_unit', unit: check.unit,
      passed: (check.active_state === null || status.active_state === check.active_state)
        && (check.sub_state === null || status.sub_state === check.sub_state),
      active_state: status.active_state ?? '', sub_state: status.sub_state ?? '',
    };
  } catch (error) {
    return { type: 'systemd_unit', unit: check.unit, passed: false, active_state: '', sub_state: '', failure: publicFailure(error) };
  }
}

function systemdRollbackPlan(mutation, status) {
  if (['enable', 'disable', 'reenable'].includes(mutation.action)) {
    if (!['enabled', 'disabled'].includes(status.unit_file_state)) validation(`transaction cannot safely restore systemd unit-file state ${status.unit_file_state ?? 'unknown'}`);
    return Object.freeze({ kind: 'unit_file', action: status.unit_file_state === 'enabled' ? 'enable' : 'disable', expected: status.unit_file_state });
  }
  if (!['active', 'inactive'].includes(status.active_state)) validation(`transaction cannot safely restore systemd active state ${status.active_state ?? 'unknown'}`);
  return Object.freeze({ kind: 'active_state', action: status.active_state === 'active' ? 'start' : 'stop', expected: status.active_state });
}

export function createAdminTransactionEngine({
  remoteExecImpl, systemdActionImpl, systemdStatusImpl,
  remoteStatImpl, remoteReadImpl, remoteWriteImpl, remotePatchImpl,
  randomIdImpl = randomUUID,
} = {}) {
  for (const [name, value] of Object.entries({ remoteExecImpl, systemdActionImpl, systemdStatusImpl, remoteStatImpl, remoteReadImpl, remoteWriteImpl, remotePatchImpl, randomIdImpl })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  async function snapshotMutation(request) {
    if (request.mutation.type === 'systemd_action') {
      const status = await systemdStatusImpl({ target: request.target, unit: request.mutation.unit });
      return Object.freeze({ type: 'systemd_action', status, rollback: systemdRollbackPlan(request.mutation, status) });
    }
    const stat = await remoteStatImpl({ target: request.target, path: request.mutation.path });
    if (stat?.type !== 'file') throw new TerminalError('validation_error', 'transaction file mutation requires an existing regular file for rollback');
    if (!Number.isFinite(stat.size) || stat.size < 0 || stat.size > MAX_FILE_BYTES) throw new TerminalError('validation_error', 'transaction rollback snapshot exceeds the 1 MiB file bound');
    const read = await remoteReadImpl({ target: request.target, path: request.mutation.path });
    if (typeof read?.text !== 'string' || !SHA256.test(read?.sha256 ?? '')) throw new TerminalError('local_capability_dependency_error', 'transaction file snapshot is missing UTF-8 text or SHA-256');
    if (read.text.includes('\0') || Buffer.byteLength(read.text, 'utf8') > MAX_FILE_BYTES) throw new TerminalError('binary_file', 'transaction rollback snapshot must be UTF-8 text no larger than 1 MiB');
    return Object.freeze({ type: request.mutation.type, text: read.text, sha256: read.sha256 });
  }

  async function applyMutation(request, snapshot) {
    const mutation = request.mutation;
    if (mutation.type === 'systemd_action') {
      const executed = await systemdActionImpl({ target: request.target, unit: mutation.unit, action: mutation.action, privilege: request.privilege });
      if (executed.exit_code !== 0 || executed.timed_out || executed.truncated) throw new TerminalError('remote_command_nonzero_exit', `systemd transaction mutation ${mutation.action} failed with status ${executed.exit_code}`);
      return {
        public: { type: 'systemd_action', unit: mutation.unit, action: mutation.action, actual_privilege: executed.actual_privilege, strategy: executed.strategy ?? null },
        afterSha: null,
      };
    }
    const expectedSha = mutation.expected_sha256 ?? snapshot.sha256;
    const executed = mutation.type === 'remote_write'
      ? await remoteWriteImpl({ target: request.target, path: mutation.path, text: mutation.text, expected_sha256: expectedSha })
      : await remotePatchImpl({ target: request.target, path: mutation.path, expected_sha256: expectedSha, hunks: mutation.hunks });
    if (!SHA256.test(executed?.sha256 ?? '')) throw new TerminalError('local_capability_dependency_error', 'transaction file mutation did not return a SHA-256 result');
    return {
      public: { type: mutation.type, path: mutation.path, before_sha256: snapshot.sha256, after_sha256: executed.sha256 },
      afterSha: executed.sha256,
    };
  }

  async function runHealth(request) {
    const checks = [];
    for (const check of request.health_checks) {
      checks.push(check.type === 'command'
        ? await runCommandCheck(check, request.target, remoteExecImpl)
        : await runSystemdCheck(check, request.target, systemdStatusImpl));
    }
    return { passed: checks.every((check) => check.passed), checks };
  }

  async function rollbackFile(request, snapshot, afterSha) {
    await remoteWriteImpl({ target: request.target, path: request.mutation.path, text: snapshot.text, expected_sha256: afterSha });
    const verified = await remoteReadImpl({ target: request.target, path: request.mutation.path });
    if (verified?.sha256 !== snapshot.sha256) throw new TerminalError('checksum_integrity_failure', 'transaction rollback verification SHA-256 mismatch');
  }

  async function rollbackSystemd(request, snapshot) {
    const rollback = snapshot.rollback;
    const executed = await systemdActionImpl({ target: request.target, unit: request.mutation.unit, action: rollback.action, privilege: request.privilege });
    if (executed.exit_code !== 0 || executed.timed_out || executed.truncated) throw new TerminalError('remote_command_nonzero_exit', `systemd rollback ${rollback.action} failed with status ${executed.exit_code}`);
    const verified = await systemdStatusImpl({ target: request.target, unit: request.mutation.unit });
    if (rollback.kind === 'active_state' && verified.active_state !== rollback.expected) throw new TerminalError('local_capability_dependency_error', 'systemd rollback active-state verification failed');
    if (rollback.kind === 'unit_file' && verified.unit_file_state !== rollback.expected) throw new TerminalError('local_capability_dependency_error', 'systemd rollback unit-file-state verification failed');
  }

  async function execute(requestInput) {
    const request = validateAdminTransactionRequest(requestInput);
    const result = baseResult(String(randomIdImpl()), request.target);
    if (request.precheck) {
      try {
        const pre = await remoteExecImpl({ target: request.target, command: request.precheck.command, timeout_ms: 15_000, max_output_bytes: 16 * 1024 });
        result.precheck = { configured: true, passed: pre.exit_code === request.precheck.expected_exit_code && !pre.timed_out && !pre.truncated, exit_code: pre.exit_code };
      } catch (error) {
        result.precheck = { configured: true, passed: false, exit_code: null, failure: publicFailure(error) };
      }
      if (!result.precheck.passed) { result.state = 'precheck_failed'; return freezeResult(result); }
    }

    let snapshot;
    try { snapshot = await snapshotMutation(request); }
    catch (error) { result.state = 'snapshot_failed'; result.mutation = { type: request.mutation.type, failure: publicFailure(error) }; return freezeResult(result); }

    let applied;
    try { applied = await applyMutation(request, snapshot); result.mutation = applied.public; }
    catch (error) { result.state = 'mutation_failed'; result.mutation = { type: request.mutation.type, failure: publicFailure(error) }; return freezeResult(result); }

    result.health = await runHealth(request);
    if (result.health.passed) { result.state = 'committed'; return freezeResult(result); }
    if (!request.rollback_on_failure) { result.state = 'health_failed'; return freezeResult(result); }

    result.rollback = { attempted: true, succeeded: false, verified: false, failure: null };
    try {
      if (request.mutation.type === 'systemd_action') await rollbackSystemd(request, snapshot);
      else await rollbackFile(request, snapshot, applied.afterSha);
      result.rollback = { attempted: true, succeeded: true, verified: true, failure: null };
      result.state = 'rolled_back';
    } catch (error) {
      result.rollback = { attempted: true, succeeded: false, verified: false, failure: publicFailure(error) };
      result.state = 'rollback_failed';
    }
    return freezeResult(result);
  }

  return Object.freeze({ execute });
}

