import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';
import { remoteRootExec } from './root-exec.mjs';
import { systemdUnitAction } from './systemd-core.mjs';
import {
  diskUsage,
  gpuInfo,
  journalRead,
  portList,
  processList,
  serviceStatus,
  systemInfo,
  validateServiceUnit,
} from './system-helpers.mjs';

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

const RAW_PROPERTIES = Object.freeze({
  raw: { type: 'string', description: 'Bounded raw diagnostic context from the parse-stable command.' },
  raw_truncated: { type: 'boolean' },
});

function outputSchema(properties, required) {
  return {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: { target: { type: 'string' }, ...properties, ...RAW_PROPERTIES },
        required: ['target', ...required, 'raw', 'raw_truncated'],
        additionalProperties: false,
      },
      FAILURE_SCHEMA,
    ],
  };
}

const targetInput = () => ({
  type: 'object',
  properties: { target: { type: 'string', minLength: 1 } },
  required: ['target'],
  additionalProperties: false,
});

const processSchema = Object.freeze({
  type: 'object',
  properties: {
    pid: { type: 'integer', minimum: 0 },
    ppid: { type: 'integer', minimum: 0 },
    user: { type: 'string' },
    state: { type: 'string' },
    cpu_percent: { type: 'number' },
    memory_percent: { type: 'number' },
    elapsed_seconds: { type: 'integer', minimum: 0 },
    command: { type: 'string' },
  },
  required: ['pid', 'ppid', 'user', 'state', 'cpu_percent', 'memory_percent', 'elapsed_seconds', 'command'],
  additionalProperties: false,
});

const listenerSchema = Object.freeze({
  type: 'object',
  properties: {
    protocol: { type: 'string' },
    state: { type: 'string' },
    local_address: { type: 'string' },
    local_port: { type: ['integer', 'null'], minimum: 0, maximum: 65535 },
    peer_address: { type: 'string' },
    peer_port: { type: ['integer', 'null'], minimum: 0, maximum: 65535 },
    process: { type: 'string' },
  },
  required: ['protocol', 'state', 'local_address', 'local_port', 'peer_address', 'peer_port', 'process'],
  additionalProperties: false,
});

const diskSchema = Object.freeze({
  type: 'object',
  properties: {
    filesystem: { type: 'string' },
    size_bytes: { type: 'integer', minimum: 0 },
    used_bytes: { type: 'integer', minimum: 0 },
    available_bytes: { type: 'integer', minimum: 0 },
    use_percent: { type: 'integer', minimum: 0 },
    mountpoint: { type: 'string' },
  },
  required: ['filesystem', 'size_bytes', 'used_bytes', 'available_bytes', 'use_percent', 'mountpoint'],
  additionalProperties: false,
});

const gpuSchema = Object.freeze({
  type: 'object',
  properties: {
    index: { type: 'integer', minimum: 0 },
    name: { type: 'string' },
    uuid: { type: 'string' },
    driver_version: { type: 'string' },
    memory_total_mib: { type: 'integer', minimum: 0 },
    memory_used_mib: { type: 'integer', minimum: 0 },
    utilization_percent: { type: 'integer', minimum: 0 },
    temperature_c: { type: 'integer' },
  },
  required: [
    'index', 'name', 'uuid', 'driver_version', 'memory_total_mib', 'memory_used_mib',
    'utilization_percent', 'temperature_c',
  ],
  additionalProperties: false,
});

export const SYSTEM_READ_TOOLS = Object.freeze([
  Object.freeze({
    name: 'system_info',
    description: 'Inspect normalized remote Ubuntu host, kernel, OS and uptime metadata using parse-stable C-locale commands.',
    inputSchema: targetInput(),
    outputSchema: outputSchema({
      hostname: { type: 'string' },
      kernel: { type: 'string' },
      architecture: { type: 'string' },
      os: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          version: { type: 'string' },
          pretty_name: { type: 'string' },
        },
        required: ['id', 'version', 'pretty_name'],
        additionalProperties: false,
      },
      uptime_seconds: { type: 'number', minimum: 0 },
    }, ['hostname', 'kernel', 'architecture', 'os', 'uptime_seconds']),
  }),
  Object.freeze({
    name: 'process_list',
    description: 'List a bounded set of remote processes with normalized PID, owner, state, CPU, memory and elapsed-time fields.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      required: ['target'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      processes: { type: 'array', maxItems: 200, items: processSchema },
      results_truncated: { type: 'boolean' },
    }, ['processes', 'results_truncated']),
  }),
  Object.freeze({
    name: 'port_list',
    description: 'List a bounded set of listening TCP/UDP sockets with normalized local/peer endpoints and available process context.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      required: ['target'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      listeners: { type: 'array', maxItems: 200, items: listenerSchema },
      results_truncated: { type: 'boolean' },
    }, ['listeners', 'results_truncated']),
  }),
  Object.freeze({
    name: 'service_status',
    description: 'Inspect one exact systemd .service unit without mutating it.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1 },
        service: { type: 'string', pattern: '^[A-Za-z0-9_.@:-]+\\.service$' },
      },
      required: ['target', 'service'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      service: { type: 'string' },
      load_state: { type: 'string' },
      active_state: { type: 'string' },
      sub_state: { type: 'string' },
      unit_file_state: { type: ['string', 'null'] },
      main_pid: { type: 'integer', minimum: 0 },
    }, ['service', 'load_state', 'active_state', 'sub_state', 'unit_file_state', 'main_pid']),
  }),
  Object.freeze({
    name: 'journal_read',
    description: 'Read a bounded number of journal entries, optionally scoped to one exact systemd .service unit.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1 },
        service: { type: 'string', pattern: '^[A-Za-z0-9_.@:-]+\\.service$' },
        lines: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
      required: ['target'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      service: { type: ['string', 'null'] },
      entries: { type: 'array', maxItems: 500, items: { type: 'string' } },
    }, ['service', 'entries']),
  }),
  Object.freeze({
    name: 'disk_usage',
    description: 'Inspect normalized filesystem capacity and usage in bytes using df with a parse-stable C locale.',
    inputSchema: targetInput(),
    outputSchema: outputSchema({
      filesystems: { type: 'array', items: diskSchema },
    }, ['filesystems']),
  }),
  Object.freeze({
    name: 'gpu_info',
    description: 'Inspect NVIDIA GPU inventory and utilization when nvidia-smi is available; report capability absence explicitly.',
    inputSchema: targetInput(),
    outputSchema: outputSchema({
      provider: { type: 'string', enum: ['nvidia-smi'] },
      available: { type: 'boolean' },
      gpus: { type: 'array', items: gpuSchema },
    }, ['provider', 'available', 'gpus']),
  }),
]);

export const SYSTEM_READ_TOOL_NAMES = new Set(SYSTEM_READ_TOOLS.map((tool) => tool.name));

const PRIVILEGE_PROPERTY = Object.freeze({
  type: 'string',
  enum: ['auto', 'user', 'root'],
  default: 'auto',
  description: 'auto tries the configured user first and escalates through the best-effort root provider only on a privilege denial; user forbids escalation; root starts privileged.',
});

const MUTATION_SUCCESS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['signal', 'start', 'stop', 'restart'] },
    target: { type: 'string' },
    privilege: { type: 'string', enum: ['user', 'root'] },
    strategy: {
      type: ['string', 'null'],
      enum: [
        null,
        'direct_root',
        'sudo_nopasswd',
        'docker_host_root',
        'sudo_password',
        'su_root_password',
      ],
    },
    pid: { type: ['integer', 'null'], minimum: 1 },
    signal: { type: ['integer', 'null'], minimum: 0, maximum: 64 },
    service: { type: ['string', 'null'] },
    exit_code: { type: ['integer', 'null'] },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    duration_ms: { type: 'number' },
    timed_out: { type: 'boolean' },
    truncated: { type: 'boolean' },
  },
  required: [
    'action', 'target', 'privilege', 'strategy', 'pid', 'signal', 'service',
    'exit_code', 'stdout', 'stderr', 'duration_ms', 'timed_out', 'truncated',
  ],
  additionalProperties: false,
});

function mutationOutputSchema() {
  return { type: 'object', oneOf: [MUTATION_SUCCESS_SCHEMA, FAILURE_SCHEMA] };
}

export const SYSTEM_MUTATION_TOOLS = Object.freeze([
  Object.freeze({
    name: 'process_signal',
    description: 'Send one validated numeric signal to one remote PID. privilege=auto (default) tries the configured user and escalates only on a privilege denial; user forbids escalation and root starts privileged.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1 },
        pid: { type: 'integer', minimum: 1 },
        signal: {
          type: 'integer',
          minimum: 0,
          maximum: 64,
          description: 'Numeric signal. 0 performs a permission/existence probe without delivering a signal.',
        },
        privilege: PRIVILEGE_PROPERTY,
      },
      required: ['target', 'pid', 'signal'],
      additionalProperties: false,
    },
    outputSchema: mutationOutputSchema(),
  }),
  ...['start', 'stop', 'restart'].map((action) => Object.freeze({
    name: `service_${action}`,
    description: `${action[0].toUpperCase()}${action.slice(1)} one exact systemd .service unit. privilege=auto (default) tries the configured user and escalates only on a privilege denial; user forbids escalation and root starts privileged.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1 },
        service: { type: 'string', pattern: '^[A-Za-z0-9_.@:-]+\\.service$' },
        privilege: PRIVILEGE_PROPERTY,
      },
      required: ['target', 'service'],
      additionalProperties: false,
    },
    outputSchema: mutationOutputSchema(),
  })),
]);

export const SYSTEM_MUTATION_TOOL_NAMES = new Set(SYSTEM_MUTATION_TOOLS.map((tool) => tool.name));
export const SYSTEM_TOOLS = Object.freeze([...SYSTEM_READ_TOOLS, ...SYSTEM_MUTATION_TOOLS]);
export const SYSTEM_TOOL_NAMES = new Set(SYSTEM_TOOLS.map((tool) => tool.name));

const READ_HANDLERS = Object.freeze({
  system_info: systemInfo,
  process_list: processList,
  port_list: portList,
  service_status: serviceStatus,
  journal_read: journalRead,
  disk_usage: diskUsage,
  gpu_info: gpuInfo,
});

function result(value, { isError = false } = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) response.isError = true;
  return response;
}

export async function callSystemReadTool(
  name,
  args,
  { remoteExecImpl } = {},
) {
  const handler = READ_HANDLERS[name];
  if (!handler) throw new TerminalError('validation_error', `Unknown read-only system tool: ${name}`);
  try {
    return result(await handler(args ?? {}, { remoteExecImpl }));
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}

function validateMutationTarget(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TerminalError('validation_error', 'system mutation request must be an object');
  }
  if (typeof args.target !== 'string' || args.target.trim() === '' || args.target.includes('\0')) {
    throw new TerminalError('validation_error', 'target must be a non-empty string without NUL bytes');
  }
  const privilege = args.privilege ?? 'auto';
  if (!['auto', 'user', 'root'].includes(privilege)) {
    throw new TerminalError('validation_error', 'privilege must be auto, user or root');
  }
  return { target: args.target.trim(), privilege };
}

function permissionFailure(stderr) {
  return /permission denied|operation not permitted|interactive authentication required|authentication is required|access denied|must be root|requires? privileges?/iu
    .test(stderr ?? '');
}

function normalizedMutation({ action, target, privilege, strategy = null, pid = null, signal = null, service = null }, executed) {
  return {
    action,
    target,
    privilege,
    strategy,
    pid,
    signal,
    service,
    exit_code: executed.exit_code,
    stdout: executed.stdout ?? '',
    stderr: executed.stderr ?? '',
    duration_ms: executed.duration_ms ?? 0,
    timed_out: Boolean(executed.timed_out),
    truncated: Boolean(executed.truncated),
  };
}

async function executeMutation(
  metadata,
  { userCommand, rootCommand },
  {
    remoteExecImpl = remoteExec,
    rootExecImpl = remoteRootExec,
    upstreamClient,
  } = {},
) {
  if (metadata.privilege === 'root') {
    const executed = await rootExecImpl(
      { target: metadata.target, command: rootCommand },
      { upstreamClient },
    );
    return normalizedMutation({ ...metadata, strategy: executed.strategy ?? null }, executed);
  }

  const executed = await remoteExecImpl({
    target: metadata.target,
    command: userCommand.command,
    env: { LC_ALL: 'C', ...(userCommand.env ?? {}) },
    timeout_ms: 15_000,
    max_output_bytes: 65_536,
  });

  if (executed.exit_code !== 0 && permissionFailure(executed.stderr)) {
    if (metadata.privilege === 'auto') {
      const elevated = await rootExecImpl(
        { target: metadata.target, command: rootCommand },
        { upstreamClient },
      );
      return normalizedMutation(
        { ...metadata, privilege: 'root', strategy: elevated.strategy ?? null },
        elevated,
      );
    }
    throw new TerminalError(
      'permission_privilege_error',
      `${metadata.toolName} requires privileges not available to the configured remote user`,
      {
        details: {
          action: metadata.action,
          target: metadata.target,
          privilege: metadata.privilege,
          exit_code: executed.exit_code,
          stderr: executed.stderr ?? '',
        },
      },
    );
  }

  return normalizedMutation({ ...metadata, privilege: 'user' }, executed);
}

async function callMutationTool(
  name,
  args,
  deps,
) {
  const { target, privilege } = validateMutationTarget(args);

  if (name === 'process_signal') {
    if (!Number.isInteger(args.pid) || args.pid < 1) {
      throw new TerminalError('validation_error', 'pid must be a positive integer');
    }
    if (!Number.isInteger(args.signal) || args.signal < 0 || args.signal > 64) {
      throw new TerminalError('validation_error', 'signal must be an integer between 0 and 64');
    }
    const command = `kill -${args.signal} ${args.pid}`;
    return executeMutation(
      {
        toolName: name,
        action: 'signal',
        target,
        privilege,
        pid: args.pid,
        signal: args.signal,
        service: null,
      },
      { userCommand: { command }, rootCommand: command },
      deps,
    );
  }

  const action = name.slice('service_'.length);
  const service = validateServiceUnit(args.service);
  const generic = await systemdUnitAction(
    { target, unit: service, action, privilege },
    {
      remoteExecImpl: deps?.remoteExecImpl ?? remoteExec,
      rootExecImpl: deps?.rootExecImpl ?? remoteRootExec,
    },
  );
  return normalizedMutation({
    action,
    target,
    privilege: generic.actual_privilege,
    strategy: generic.strategy,
    pid: null,
    signal: null,
    service,
  }, generic);
}

export async function callSystemTool(name, args, deps = {}) {
  if (SYSTEM_READ_TOOL_NAMES.has(name)) {
    return callSystemReadTool(name, args, deps);
  }
  if (!SYSTEM_MUTATION_TOOL_NAMES.has(name)) {
    throw new TerminalError('validation_error', `Unknown system tool: ${name}`);
  }
  try {
    return result(await callMutationTool(name, args ?? {}, deps));
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}

