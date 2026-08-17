import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import {
  SYSTEMD_ACTIONS,
  SYSTEMD_UNIT_PATTERN,
  SYSTEMD_UNIT_TYPES,
  systemdDaemonReload,
  systemdUnitAction,
  systemdUnitDependencies,
  systemdUnitList,
  systemdUnitStatus,
} from './systemd-core.mjs';

const FAILURE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...ERROR_CATEGORIES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    details: {},
  },
  required: ['category', 'message', 'retryable'],
  additionalProperties: false,
});

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const RAW_PROPERTIES = {
  raw: { type: 'string' },
  raw_truncated: { type: 'boolean' },
};

const UNIT_PATTERN = SYSTEMD_UNIT_PATTERN;
const PRIVILEGE_PROPERTY = Object.freeze({
  type: 'string',
  enum: ['auto', 'user', 'root'],
  default: 'auto',
});
const MUTATION_PROPERTIES = {
  action: { type: 'string' },
  target: { type: 'string' },
  unit: { type: ['string', 'null'] },
  requested_privilege: { type: 'string', enum: ['auto', 'user', 'root'] },
  actual_privilege: { type: 'string', enum: ['user', 'root'] },
  strategy: { type: ['string', 'null'] },
  exit_code: { type: ['integer', 'null'] },
  stdout: { type: 'string' },
  stderr: { type: 'string' },
  duration_ms: { type: 'number', minimum: 0 },
  timed_out: { type: 'boolean' },
  truncated: { type: 'boolean' },
};
const MUTATION_REQUIRED = Object.keys(MUTATION_PROPERTIES);
const STATUS_PROPERTIES = {
  target: { type: 'string' },
  unit: { type: 'string' },
  names: { type: 'array', items: { type: 'string' } },
  description: { type: 'string' },
  load_state: { type: 'string' },
  active_state: { type: 'string' },
  sub_state: { type: 'string' },
  unit_file_state: { type: ['string', 'null'] },
  main_pid: { type: 'integer', minimum: 0 },
  result: { type: ['string', 'null'] },
  ...RAW_PROPERTIES,
};
const STATUS_REQUIRED = Object.keys(STATUS_PROPERTIES);

function successOrFailure(properties, required) {
  return {
    type: 'object',
    oneOf: [objectSchema(properties, required), FAILURE_SCHEMA],
  };
}

export const SYSTEMD_TOOLS = Object.freeze([
  Object.freeze({
    name: 'systemd_unit_status',
    description: 'Inspect one exact supported systemd unit without mutating it.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1 },
      unit: { type: 'string', pattern: UNIT_PATTERN },
    }, ['target', 'unit']),
    outputSchema: successOrFailure(STATUS_PROPERTIES, STATUS_REQUIRED),
  }),
  Object.freeze({
    name: 'systemd_unit_list',
    description: 'List a bounded set of loaded systemd units, optionally filtered by supported unit type.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: [...SYSTEMD_UNIT_TYPES] },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    }, ['target']),
    outputSchema: successOrFailure({
      target: { type: 'string' },
      type: { type: ['string', 'null'] },
      units: {
        type: 'array',
        maxItems: 200,
        items: objectSchema({
          unit: { type: 'string' },
          load_state: { type: 'string' },
          active_state: { type: 'string' },
          sub_state: { type: 'string' },
          description: { type: 'string' },
        }, ['unit', 'load_state', 'active_state', 'sub_state', 'description']),
      },
      results_truncated: { type: 'boolean' },
      ...RAW_PROPERTIES,
    }, ['target', 'type', 'units', 'results_truncated', 'raw', 'raw_truncated']),
  }),
  Object.freeze({
    name: 'systemd_unit_dependencies',
    description: 'Inspect Requires/Wants/Before/After/Conflicts relationships for one exact supported systemd unit.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1 },
      unit: { type: 'string', pattern: UNIT_PATTERN },
    }, ['target', 'unit']),
    outputSchema: successOrFailure({
      target: { type: 'string' },
      unit: { type: 'string' },
      requires: { type: 'array', items: { type: 'string' } },
      wants: { type: 'array', items: { type: 'string' } },
      before: { type: 'array', items: { type: 'string' } },
      after: { type: 'array', items: { type: 'string' } },
      conflicts: { type: 'array', items: { type: 'string' } },
      ...RAW_PROPERTIES,
    }, ['target', 'unit', 'requires', 'wants', 'before', 'after', 'conflicts', 'raw', 'raw_truncated']),
  }),
  Object.freeze({
    name: 'systemd_unit_action',
    description: 'Perform one validated systemd unit action with capability-first privilege selection.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1 },
      unit: { type: 'string', pattern: UNIT_PATTERN },
      action: { type: 'string', enum: [...SYSTEMD_ACTIONS] },
      privilege: PRIVILEGE_PROPERTY,
    }, ['target', 'unit', 'action']),
    outputSchema: successOrFailure(MUTATION_PROPERTIES, MUTATION_REQUIRED),
  }),
  Object.freeze({
    name: 'systemd_daemon_reload',
    description: 'Reload the systemd manager configuration. Defaults to privileged execution; user is a strict no-escalation override and auto escalates only on privilege denial.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1 },
      privilege: { ...PRIVILEGE_PROPERTY, default: 'root' },
    }, ['target']),
    outputSchema: successOrFailure(MUTATION_PROPERTIES, MUTATION_REQUIRED),
  }),
]);

export const SYSTEMD_TOOL_NAMES = new Set(SYSTEMD_TOOLS.map((tool) => tool.name));

function result(value, { isError = false } = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) response.isError = true;
  return response;
}

export async function callSystemdTool(
  name,
  args,
  {
    remoteExecImpl,
    rootExecImpl,
    statusImpl = systemdUnitStatus,
    listImpl = systemdUnitList,
    dependenciesImpl = systemdUnitDependencies,
    actionImpl = systemdUnitAction,
    daemonReloadImpl = systemdDaemonReload,
  } = {},
) {
  if (!SYSTEMD_TOOL_NAMES.has(name)) {
    throw new TerminalError('validation_error', `Unknown systemd tool: ${name}`);
  }
  try {
    if (name === 'systemd_unit_status') return result(await statusImpl(args ?? {}, { remoteExecImpl }));
    if (name === 'systemd_unit_list') return result(await listImpl(args ?? {}, { remoteExecImpl }));
    if (name === 'systemd_unit_dependencies') return result(await dependenciesImpl(args ?? {}, { remoteExecImpl }));
    if (name === 'systemd_unit_action') {
      return result(await actionImpl(args ?? {}, { remoteExecImpl, rootExecImpl }));
    }
    return result(await daemonReloadImpl(args ?? {}, { remoteExecImpl, rootExecImpl }));
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}

