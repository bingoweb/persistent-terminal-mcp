import { TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';

export const SYSTEMD_UNIT_TYPES = Object.freeze([
  'service',
  'socket',
  'timer',
  'path',
  'mount',
  'automount',
  'target',
  'slice',
  'scope',
]);
export const SYSTEMD_ACTIONS = Object.freeze([
  'start',
  'stop',
  'restart',
  'reload',
  'try-restart',
  'reload-or-restart',
  'enable',
  'disable',
  'reenable',
  'mask',
  'unmask',
  'reset-failed',
]);

const TYPE_SET = new Set(SYSTEMD_UNIT_TYPES);
const ACTION_SET = new Set(SYSTEMD_ACTIONS);
export const SYSTEMD_UNIT_PATTERN = `^(?:[A-Za-z0-9_.@:-]|\\\\x[0-9A-Fa-f]{2})+\\.(${SYSTEMD_UNIT_TYPES.join('|')})$`;
const UNIT_RE = new RegExp(SYSTEMD_UNIT_PATTERN, 'u');
const SAFE_TARGET = /^[^\s\0-][^\s\0]*$/u;
const STATUS_MAX_BYTES = 32 * 1024;
const LIST_MAX_BYTES = 256 * 1024;
const DEPENDENCY_MAX_BYTES = 64 * 1024;
const MUTATION_MAX_BYTES = 64 * 1024;
const RAW_CONTEXT_BYTES = 16 * 1024;

const STATUS_COMMAND = String.raw`systemctl show --no-pager --property=Id --property=Names --property=Description --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState --property=MainPID --property=Result "$PTEXT_UNIT"`;
const DEPENDENCY_COMMAND = String.raw`systemctl show --no-pager --property=Requires --property=Wants --property=Before --property=After --property=Conflicts "$PTEXT_UNIT"`;
const LIST_COMMAND_ALL = String.raw`set -o pipefail; systemctl list-units --all --no-legend --no-pager --plain | head -n "$PTEXT_LIMIT_PLUS_ONE"`;
const LIST_COMMAND_TYPE = String.raw`set -o pipefail; systemctl list-units --all --no-legend --no-pager --plain --type="$PTEXT_TYPE" | head -n "$PTEXT_LIMIT_PLUS_ONE"`;

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty OpenSSH host or alias');
  }
  const normalized = target.trim();
  if (!SAFE_TARGET.test(normalized)) {
    throw new TerminalError('validation_error', 'target must be a safe OpenSSH host or alias');
  }
  return normalized;
}

export function validateSystemdUnit(unit) {
  if (typeof unit !== 'string' || unit.trim() !== unit || unit === '') {
    throw new TerminalError('validation_error', 'unit must be an exact systemd unit name with a supported suffix');
  }
  if (unit.includes('\0') || !UNIT_RE.test(unit)) {
    throw new TerminalError('validation_error', 'unit must be an exact systemd unit name with a supported suffix');
  }
  return unit;
}

export function validateSystemdUnitType(type) {
  if (type === undefined || type === null) return null;
  if (typeof type !== 'string' || !TYPE_SET.has(type)) {
    throw new TerminalError('validation_error', 'systemd unit type must be one of the supported unit types');
  }
  return type;
}

export function validateSystemdAction(action) {
  if (typeof action !== 'string' || !ACTION_SET.has(action)) {
    throw new TerminalError('validation_error', 'systemd action must be one of the supported exact actions');
  }
  return action;
}

function validatePrivilege(value, fallback = 'auto') {
  const privilege = value ?? fallback;
  if (!['auto', 'user', 'root'].includes(privilege)) {
    throw new TerminalError('validation_error', 'privilege must be auto, user or root');
  }
  return privilege;
}

function permissionFailure(stderr) {
  return /permission denied|operation not permitted|interactive authentication required|access denied|authentication is required|polkit|not authorized|must be root|requires root/iu
    .test(stderr ?? '');
}

function normalizeMutation({ action, target, unit = null, requestedPrivilege, actualPrivilege, strategy }, executed) {
  return Object.freeze({
    action,
    target,
    unit,
    requested_privilege: requestedPrivilege,
    actual_privilege: actualPrivilege,
    strategy: strategy ?? null,
    exit_code: executed.exit_code,
    stdout: executed.stdout ?? '',
    stderr: executed.stderr ?? '',
    duration_ms: executed.duration_ms ?? 0,
    timed_out: Boolean(executed.timed_out),
    truncated: Boolean(executed.truncated),
  });
}

function rootUnitCommand(action, unit) {
  const fixed = 'systemctl --no-ask-password "$1" "$2"';
  return `/bin/bash -lc ${quotePosix(fixed)} ptext-systemd ${quotePosix(action)} ${quotePosix(unit)}`;
}

async function executeMutation({
  target,
  action,
  unit,
  privilege,
  userCommand,
  userEnv = {},
  rootCommand,
  remoteExecImpl,
  rootExecImpl,
  label,
}) {
  if (privilege === 'root') {
    const elevated = await rootExecImpl({ target, command: rootCommand });
    return normalizeMutation({
      action,
      target,
      unit,
      requestedPrivilege: privilege,
      actualPrivilege: 'root',
      strategy: elevated.strategy ?? null,
    }, elevated);
  }

  const executed = await remoteExecImpl({
    target,
    command: userCommand,
    env: { LC_ALL: 'C', ...userEnv },
    timeout_ms: 15_000,
    max_output_bytes: MUTATION_MAX_BYTES,
  });
  if (executed.exit_code !== 0 && permissionFailure(executed.stderr)) {
    if (privilege === 'auto') {
      const elevated = await rootExecImpl({ target, command: rootCommand });
      return normalizeMutation({
        action,
        target,
        unit,
        requestedPrivilege: privilege,
        actualPrivilege: 'root',
        strategy: elevated.strategy ?? null,
      }, elevated);
    }
    throw new TerminalError(
      'permission_privilege_error',
      `${label} requires privileges not available to the configured remote user`,
      {
        details: {
          action,
          target,
          unit,
          privilege,
          exit_code: executed.exit_code,
          stderr: executed.stderr ?? '',
        },
      },
    );
  }
  return normalizeMutation({
    action,
    target,
    unit,
    requestedPrivilege: privilege,
    actualPrivilege: 'user',
    strategy: null,
  }, executed);
}

function boundedRaw(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= RAW_CONTEXT_BYTES) return { raw: text, raw_truncated: false };
  return {
    raw: bytes.subarray(0, RAW_CONTEXT_BYTES).toString('utf8'),
    raw_truncated: true,
  };
}

function parseProperties(stdout) {
  const properties = new Map();
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

function parseNonNegativeInteger(value, field) {
  if (value === '' || value === undefined) return 0;
  if (!/^[0-9]+$/u.test(value)) {
    throw new TerminalError('local_capability_dependency_error', `systemd returned invalid ${field}`);
  }
  return Number.parseInt(value, 10);
}

function splitUnits(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return [...new Set(value.trim().split(/\s+/u).filter(Boolean))].sort();
}

export function parseSystemdStatusOutput(stdout) {
  const properties = parseProperties(stdout);
  const unit = properties.get('Id') ?? '';
  if (unit === '' || properties.get('LoadState') === undefined || properties.get('ActiveState') === undefined) {
    throw new TerminalError('local_capability_dependency_error', 'systemd status output is missing required properties');
  }
  validateSystemdUnit(unit);
  return Object.freeze({
    unit,
    names: Object.freeze(splitUnits(properties.get('Names'))),
    description: properties.get('Description') ?? '',
    load_state: properties.get('LoadState') ?? '',
    active_state: properties.get('ActiveState') ?? '',
    sub_state: properties.get('SubState') ?? '',
    unit_file_state: properties.get('UnitFileState') || null,
    main_pid: parseNonNegativeInteger(properties.get('MainPID'), 'MainPID'),
    result: properties.get('Result') || null,
  });
}

export function parseSystemdListOutput(stdout) {
  const units = [];
  for (let line of String(stdout ?? '').split(/\r?\n/u)) {
    line = line.trim();
    if (line === '') continue;
    if (line.startsWith('● ')) line = line.slice(2).trimStart();
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (!match) {
      throw new TerminalError('local_capability_dependency_error', 'systemd list output contained an unparseable row');
    }
    validateSystemdUnit(match[1]);
    units.push(Object.freeze({
      unit: match[1],
      load_state: match[2],
      active_state: match[3],
      sub_state: match[4],
      description: match[5] ?? '',
    }));
  }
  return Object.freeze(units);
}

export function parseSystemdDependenciesOutput(stdout) {
  const properties = parseProperties(stdout);
  return Object.freeze({
    requires: Object.freeze(splitUnits(properties.get('Requires'))),
    wants: Object.freeze(splitUnits(properties.get('Wants'))),
    before: Object.freeze(splitUnits(properties.get('Before'))),
    after: Object.freeze(splitUnits(properties.get('After'))),
    conflicts: Object.freeze(splitUnits(properties.get('Conflicts'))),
  });
}

async function executeRead({ target, command, env, maxOutputBytes, remoteExecImpl, label }) {
  const executed = await remoteExecImpl({
    target,
    command,
    env: { LC_ALL: 'C', ...env },
    timeout_ms: 15_000,
    max_output_bytes: maxOutputBytes,
  });
  if (executed.timed_out) {
    throw new TerminalError('timeout', `${label} timed out`, { retryable: true, details: { target } });
  }
  if (executed.exit_code !== 0) {
    const stderr = typeof executed.stderr === 'string' ? executed.stderr.trim().slice(0, 500) : '';
    throw new TerminalError(
      'remote_command_nonzero_exit',
      `${label} failed with status ${executed.exit_code}${stderr ? `: ${stderr}` : ''}`,
      { details: { target, exit_code: executed.exit_code } },
    );
  }
  if (executed.truncated) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `${label} exceeded its bounded output contract`,
      { details: { target } },
    );
  }
  return executed;
}

export async function systemdUnitStatus(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateTarget(request?.target);
  const unit = validateSystemdUnit(request?.unit);
  const executed = await executeRead({
    target,
    command: STATUS_COMMAND,
    env: { PTEXT_UNIT: unit },
    maxOutputBytes: STATUS_MAX_BYTES,
    remoteExecImpl,
    label: `systemd status for ${unit}`,
  });
  return Object.freeze({
    target,
    ...parseSystemdStatusOutput(executed.stdout),
    ...boundedRaw(executed.stdout),
  });
}

export async function systemdUnitList(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateTarget(request?.target);
  const type = validateSystemdUnitType(request?.type);
  const limit = request?.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new TerminalError('validation_error', 'limit must be an integer between 1 and 200');
  }
  const env = { PTEXT_LIMIT_PLUS_ONE: String(limit + 1) };
  if (type) env.PTEXT_TYPE = type;
  const executed = await executeRead({
    target,
    command: `/bin/bash -lc ${quotePosix(type ? LIST_COMMAND_TYPE : LIST_COMMAND_ALL)}`,
    env,
    maxOutputBytes: LIST_MAX_BYTES,
    remoteExecImpl,
    label: 'systemd unit list',
  });
  const parsed = parseSystemdListOutput(executed.stdout);
  return Object.freeze({
    target,
    type,
    units: Object.freeze(parsed.slice(0, limit)),
    results_truncated: parsed.length > limit,
    ...boundedRaw(executed.stdout),
  });
}

export async function systemdUnitDependencies(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateTarget(request?.target);
  const unit = validateSystemdUnit(request?.unit);
  const executed = await executeRead({
    target,
    command: DEPENDENCY_COMMAND,
    env: { PTEXT_UNIT: unit },
    maxOutputBytes: DEPENDENCY_MAX_BYTES,
    remoteExecImpl,
    label: `systemd dependencies for ${unit}`,
  });
  return Object.freeze({
    target,
    unit,
    ...parseSystemdDependenciesOutput(executed.stdout),
    ...boundedRaw(executed.stdout),
  });
}

export async function systemdUnitAction(
  request,
  { remoteExecImpl = remoteExec, rootExecImpl } = {},
) {
  const target = validateTarget(request?.target);
  const unit = validateSystemdUnit(request?.unit);
  const action = validateSystemdAction(request?.action);
  const privilege = validatePrivilege(request?.privilege, 'auto');
  if (typeof rootExecImpl !== 'function') {
    throw new TypeError('rootExecImpl must be a function for systemd mutations');
  }
  return executeMutation({
    target,
    action,
    unit,
    privilege,
    userCommand: 'systemctl --no-ask-password "$PTEXT_ACTION" "$PTEXT_UNIT"',
    userEnv: { PTEXT_ACTION: action, PTEXT_UNIT: unit },
    rootCommand: rootUnitCommand(action, unit),
    remoteExecImpl,
    rootExecImpl,
    label: `systemd ${action} ${unit}`,
  });
}

export async function systemdDaemonReload(
  request,
  { remoteExecImpl = remoteExec, rootExecImpl } = {},
) {
  const target = validateTarget(request?.target);
  const privilege = validatePrivilege(request?.privilege, 'root');
  if (typeof rootExecImpl !== 'function') {
    throw new TypeError('rootExecImpl must be a function for systemd mutations');
  }
  const command = 'systemctl --no-ask-password daemon-reload';
  return executeMutation({
    target,
    action: 'daemon-reload',
    unit: null,
    privilege,
    userCommand: command,
    rootCommand: command,
    remoteExecImpl,
    rootExecImpl,
    label: 'systemd daemon-reload',
  });
}

function quotePosix(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

