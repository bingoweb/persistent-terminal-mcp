import net from 'node:net';

import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import { createForwardManager, readProcessIdentity } from './forward-manager.mjs';
import { createForwardDefinition } from './forward-model.mjs';
import { remoteExec } from './remote-exec.mjs';

const LOCAL_PROBE_TIMEOUT_MS = 500;
const REMOTE_PROBE_TIMEOUT_MS = 5000;
const REMOTE_PROBE_OUTPUT_BYTES = 262144;
const HEALTH_RETRY_ATTEMPTS = 20;
const HEALTH_RETRY_DELAY_MS = 100;

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

const HEALTH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['healthy', 'unhealthy', 'stale', 'closed'] },
    process_identity_ok: { type: 'boolean' },
    listener_ok: { type: 'boolean' },
  },
  required: ['state', 'process_identity_ok', 'listener_ok'],
  additionalProperties: false,
});

const PUBLIC_FORWARD_PROPERTIES = Object.freeze({
  forward_id: { type: 'string', minLength: 1 },
  name: { type: ['string', 'null'] },
  target: { type: 'string', minLength: 1 },
  type: { type: 'string', enum: ['local', 'remote', 'dynamic'] },
  bind_address: { type: 'string', minLength: 1 },
  listen_port: { type: 'integer', minimum: 1, maximum: 65535 },
  destination_host: { type: 'string', minLength: 1 },
  destination_port: { type: 'integer', minimum: 1, maximum: 65535 },
  pid: { type: 'integer', minimum: 1 },
  process_started_at: { type: 'string', minLength: 1 },
  created_at: { type: 'string', minLength: 1 },
  health: HEALTH_SCHEMA,
});

const PUBLIC_FORWARD_REQUIRED = Object.freeze([
  'forward_id',
  'name',
  'target',
  'type',
  'bind_address',
  'listen_port',
  'pid',
  'process_started_at',
  'created_at',
  'health',
]);

function publicForwardSchema(extraProperties = {}, extraRequired = []) {
  return {
    type: 'object',
    properties: { ...PUBLIC_FORWARD_PROPERTIES, ...extraProperties },
    required: [...PUBLIC_FORWARD_REQUIRED, ...extraRequired],
    additionalProperties: false,
  };
}

function outputSchema(success) {
  return { type: 'object', oneOf: [success, FAILURE_SCHEMA] };
}

const SELECTOR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    forward_id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
});

export const FORWARD_TOOLS = Object.freeze([
  Object.freeze({
    name: 'forward_create',
    description: 'Create or reuse a managed native OpenSSH local, remote, or dynamic forward with health verification.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['local', 'remote', 'dynamic'] },
        bind_address: { type: 'string', minLength: 1 },
        listen_port: { type: 'integer', minimum: 1, maximum: 65535 },
        destination_host: { type: 'string', minLength: 1 },
        destination_port: { type: 'integer', minimum: 1, maximum: 65535 },
      },
      required: ['target', 'type', 'listen_port'],
      additionalProperties: false,
    },
    outputSchema: outputSchema(publicForwardSchema(
      { reused: { type: 'boolean' } },
      ['reused'],
    )),
  }),
  Object.freeze({
    name: 'forward_list',
    description: 'List managed SSH forwards with current process/listener health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: outputSchema({
      type: 'object',
      properties: {
        forwards: { type: 'array', items: publicForwardSchema() },
      },
      required: ['forwards'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'forward_status',
    description: 'Return current process identity and listener health for one managed SSH forward.',
    inputSchema: SELECTOR_SCHEMA,
    outputSchema: outputSchema(publicForwardSchema()),
  }),
  Object.freeze({
    name: 'forward_close',
    description: 'Close one managed SSH forward after verifying its recorded process identity.',
    inputSchema: SELECTOR_SCHEMA,
    outputSchema: outputSchema(publicForwardSchema(
      { closed: { type: 'boolean' } },
      ['closed'],
    )),
  }),
]);

export const FORWARD_TOOL_NAMES = new Set(FORWARD_TOOLS.map((tool) => tool.name));

function result(value, { isError = false } = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) response.isError = true;
  return response;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityMatches(record, identity) {
  return identity !== null
    && identity?.started_at === record.process_started_at
    && identity?.identity === record.process_identity;
}

function probeAddress(bindAddress) {
  if (bindAddress === '0.0.0.0' || bindAddress === '*') return '127.0.0.1';
  if (bindAddress === '::') return '::1';
  return bindAddress;
}

export async function probeLocalTcp(
  host,
  port,
  {
    timeoutMs = LOCAL_PROBE_TIMEOUT_MS,
    connectImpl = net.connect,
  } = {},
) {
  if (typeof host !== 'string' || host.length === 0 || host.includes('\0')) {
    throw new TerminalError('validation_error', 'TCP probe host must be a non-empty string');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TerminalError('validation_error', 'TCP probe port must be between 1 and 65535');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TerminalError('validation_error', 'TCP probe timeout must be a positive integer');
  }

  return new Promise((resolve) => {
    let settled = false;
    let socket;
    let timer;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket?.destroy?.();
      resolve(healthy);
    };

    try {
      socket = connectImpl({ host, port });
    } catch {
      finish(false);
      return;
    }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

function parseSsEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
  const lastColon = endpoint.lastIndexOf(':');
  if (lastColon < 0) return null;
  const port = Number.parseInt(endpoint.slice(lastColon + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let host = endpoint.slice(0, lastColon);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, port };
}

function bindMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === '0.0.0.0') return actual === '*' || actual === '0.0.0.0';
  if (expected === '::') return actual === '*' || actual === '::';
  return false;
}

export async function checkRemoteListener(
  target,
  bindAddress,
  port,
  { remoteExecImpl = remoteExec } = {},
) {
  const response = await remoteExecImpl({
    target,
    command: 'ss -ltnH',
    timeout_ms: REMOTE_PROBE_TIMEOUT_MS,
    max_output_bytes: REMOTE_PROBE_OUTPUT_BYTES,
  });

  if (response.timed_out) return false;
  if (response.exit_code !== 0) {
    const stderr = response.stderr ?? '';
    if (response.exit_code === 127 || /(?:^|\s)ss(?::|\s).*not found/iu.test(stderr)) {
      throw new TerminalError(
        'missing_remote_capability',
        'remote forward health requires ss',
        { details: { capability: 'ss', target } },
      );
    }
    throw new TerminalError(
      'remote_command_nonzero_exit',
      `remote listener probe exited with status ${response.exit_code}`,
      { details: { target, exit_code: response.exit_code, stderr } },
    );
  }
  if (response.truncated) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'remote listener probe output was truncated',
      { details: { target } },
    );
  }

  for (const line of (response.stdout ?? '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 4) continue;
    const endpoint = parseSsEndpoint(columns[3]);
    if (endpoint && endpoint.port === port && bindMatches(bindAddress, endpoint.host)) {
      return true;
    }
  }
  return false;
}

export async function checkForwardHealth(
  record,
  {
    readProcessIdentityImpl = readProcessIdentity,
    probeLocalTcpImpl = probeLocalTcp,
    checkRemoteListenerImpl = checkRemoteListener,
  } = {},
) {
  const identity = await readProcessIdentityImpl(record.pid);
  if (!identityMatches(record, identity)) {
    return {
      state: 'stale',
      process_identity_ok: false,
      listener_ok: false,
    };
  }

  const listenerOk = record.type === 'remote'
    ? await checkRemoteListenerImpl(record.target, record.bind_address, record.listen_port)
    : await probeLocalTcpImpl(probeAddress(record.bind_address), record.listen_port);

  return {
    state: listenerOk ? 'healthy' : 'unhealthy',
    process_identity_ok: true,
    listener_ok: Boolean(listenerOk),
  };
}

function publicRecord(record, health) {
  const value = {
    forward_id: record.forward_id,
    name: record.name ?? null,
    target: record.target,
    type: record.type,
    bind_address: record.bind_address,
    listen_port: record.listen_port,
    pid: record.pid,
    process_started_at: record.process_started_at,
    created_at: record.created_at,
    health,
  };
  if (record.type !== 'dynamic') {
    value.destination_host = record.destination_host;
    value.destination_port = record.destination_port;
  }
  return value;
}

function selector(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TerminalError('validation_error', 'forward selector arguments must be an object');
  }
  const values = [args.forward_id, args.name].filter((value) => value !== undefined);
  if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length === 0 || values[0].includes('\0')) {
    throw new TerminalError('validation_error', 'exactly one of forward_id or name is required');
  }
  return values[0];
}

function sameDefinition(left, right) {
  return left.target === right.target
    && left.type === right.type
    && left.bind_address === right.bind_address
    && left.listen_port === right.listen_port
    && (left.destination_host ?? null) === (right.destination_host ?? null)
    && (left.destination_port ?? null) === (right.destination_port ?? null);
}

async function waitForHealthy(
  record,
  checkForwardHealthImpl,
  waitImpl,
  attempts = HEALTH_RETRY_ATTEMPTS,
) {
  let lastHealth = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastHealth = await checkForwardHealthImpl(record);
    if (lastHealth.state === 'healthy' || lastHealth.state === 'stale') return lastHealth;
    if (attempt + 1 < attempts) await waitImpl(HEALTH_RETRY_DELAY_MS);
  }
  return lastHealth;
}

export async function callForwardTool(
  name,
  args = {},
  {
    forwardManager = createForwardManager(),
    checkForwardHealthImpl = checkForwardHealth,
    createForwardDefinitionImpl = createForwardDefinition,
    waitImpl = delay,
  } = {},
) {
  try {
    if (!FORWARD_TOOL_NAMES.has(name)) {
      throw new TerminalError('validation_error', `Unknown forward tool: ${name}`);
    }

    if (name === 'forward_list') {
      if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
        throw new TerminalError('validation_error', 'forward_list does not accept arguments');
      }
      const records = await forwardManager.listRecords();
      const forwards = [];
      for (const record of records) {
        forwards.push(publicRecord(record, await checkForwardHealthImpl(record)));
      }
      return result({ forwards });
    }

    if (name === 'forward_status') {
      const identifier = selector(args);
      const record = await forwardManager.findRecord(identifier);
      if (!record) {
        throw new TerminalError(
          'stale_session_task_forward_id',
          `unknown forward: ${identifier}`,
          { details: { forward_id: identifier } },
        );
      }
      return result(publicRecord(record, await checkForwardHealthImpl(record)));
    }

    if (name === 'forward_close') {
      const identifier = selector(args);
      const record = await forwardManager.findRecord(identifier);
      if (!record) {
        throw new TerminalError(
          'stale_session_task_forward_id',
          `unknown forward: ${identifier}`,
          { details: { forward_id: identifier } },
        );
      }
      await forwardManager.close(identifier);
      return result({
        ...publicRecord(record, {
          state: 'closed',
          process_identity_ok: false,
          listener_ok: false,
        }),
        closed: true,
      });
    }

    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new TerminalError('validation_error', 'forward_create arguments must be an object');
    }
    const existing = await forwardManager.listRecords();
    const namedExisting = typeof args.name === 'string'
      ? existing.find((record) => record.name === args.name) ?? null
      : null;
    const requested = createForwardDefinitionImpl(args, {
      existingDefinitions: namedExisting
        ? existing.filter((record) => record.forward_id !== namedExisting.forward_id)
        : existing,
    });

    if (namedExisting) {
      if (!sameDefinition(namedExisting, requested)) {
        throw new TerminalError(
          'validation_error',
          `forward name already exists with a different definition: ${args.name}`,
          { details: { name: args.name, forward_id: namedExisting.forward_id } },
        );
      }
      const health = await checkForwardHealthImpl(namedExisting);
      if (health.state !== 'healthy') {
        throw new TerminalError(
          'stale_session_task_forward_id',
          `named forward exists but is not healthy: ${args.name}`,
          { details: { name: args.name, forward_id: namedExisting.forward_id, health } },
        );
      }
      return result({ ...publicRecord(namedExisting, health), reused: true });
    }

    const created = await forwardManager.create(requested);
    const health = await waitForHealthy(created, checkForwardHealthImpl, waitImpl);
    if (health?.state !== 'healthy') {
      await forwardManager.close(created.forward_id).catch(() => {});
      throw new TerminalError(
        'transport_reconnect_failure',
        'SSH forward started but did not become healthy',
        { retryable: true, details: { forward_id: created.forward_id, health } },
      );
    }
    return result({ ...publicRecord(created, health), reused: false });
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}
