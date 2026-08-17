import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import {
  ROOT_PROVIDER_NAMES,
  TARGET_CAPABILITY_NAMES,
  createCapabilityInventory,
} from './target-capabilities.mjs';
import { diagnoseTarget } from './target-diagnostics.mjs';
import { TELEMETRY_COUNTERS, TELEMETRY_TIMINGS, terminalTelemetry } from './telemetry.mjs';

const defaultCapabilityInventory = createCapabilityInventory();

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

const CAPABILITY_SCHEMA = objectSchema({
  available: { type: 'boolean' },
  version: { type: ['string', 'null'] },
}, ['available', 'version']);

const CAPABILITIES_SCHEMA = objectSchema(
  Object.fromEntries(TARGET_CAPABILITY_NAMES.map((name) => [name, CAPABILITY_SCHEMA])),
  [...TARGET_CAPABILITY_NAMES],
);

const ROOT_PROVIDERS_SCHEMA = objectSchema(
  Object.fromEntries(ROOT_PROVIDER_NAMES.map((name) => [name, { type: 'boolean' }])),
  [...ROOT_PROVIDER_NAMES],
);

const IDENTITY_SCHEMA = objectSchema({
  hostname: { type: 'string', minLength: 1 },
  user: { type: 'string', minLength: 1 },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  proxy_jump: { type: ['string', 'null'] },
}, ['hostname', 'user', 'port', 'proxy_jump']);

const CACHE_SCHEMA = objectSchema({
  status: { type: 'string', enum: ['hit', 'miss', 'refresh'] },
  ttl_ms: { type: 'integer', minimum: 1, maximum: 3_600_000 },
}, ['status', 'ttl_ms']);

const INVENTORY_SUCCESS_SCHEMA = objectSchema({
  target: { type: 'string', minLength: 1 },
  identity: IDENTITY_SCHEMA,
  user: { type: 'string', minLength: 1 },
  uid: { type: 'integer', minimum: 0 },
  capabilities: CAPABILITIES_SCHEMA,
  root_providers: ROOT_PROVIDERS_SCHEMA,
  collected_at: { type: 'string', minLength: 1 },
  expires_at: { type: 'string', minLength: 1 },
  cache: CACHE_SCHEMA,
}, [
  'target', 'identity', 'user', 'uid', 'capabilities', 'root_providers',
  'collected_at', 'expires_at', 'cache',
]);

const MULTIPLEX_SCHEMA = objectSchema({
  mode: { type: 'string', enum: ['off', 'auto', 'required', 'unmanaged'] },
  state: { type: 'string', enum: ['off', 'active', 'inactive', 'unavailable'] },
  active: { type: 'boolean' },
  target_hash: { type: ['string', 'null'] },
}, ['mode', 'state', 'active', 'target_hash']);

const TRANSPORT_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'failure'] },
  identity: IDENTITY_SCHEMA,
  failure: FAILURE_SCHEMA,
  multiplex: MULTIPLEX_SCHEMA,
}, ['state', 'multiplex']);

const REMOTE_IDENTITY_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable'] },
  user: { type: 'string', minLength: 1 },
  uid: { type: 'integer', minimum: 0 },
}, ['state']);

const SYSTEM_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'failure', 'unavailable'] },
  hostname: { type: 'string' },
  kernel: { type: 'string' },
  architecture: { type: 'string' },
  os: objectSchema({
    id: { type: 'string' },
    version: { type: 'string' },
    pretty_name: { type: 'string' },
  }, ['id', 'version', 'pretty_name']),
  uptime_seconds: { type: 'number', minimum: 0 },
  failure: FAILURE_SCHEMA,
}, ['state']);

const PRIVILEGE_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'permission_limited', 'unavailable', 'failure'] },
  root_providers: { oneOf: [ROOT_PROVIDERS_SCHEMA, { type: 'null' }] },
  cache: objectSchema({
    state: { type: 'string', enum: ['available', 'unavailable'] },
    ttl_ms: { type: ['integer', 'null'], minimum: 1, maximum: 3_600_000 },
    entries: { type: ['integer', 'null'], minimum: 0 },
    providers: objectSchema({
      direct_root: { type: 'integer', minimum: 0 },
      sudo_nopasswd: { type: 'integer', minimum: 0 },
      docker_host_root: { type: 'integer', minimum: 0 },
    }, ['direct_root', 'sudo_nopasswd', 'docker_host_root']),
  }, ['state', 'ttl_ms', 'entries', 'providers']),
  failure: FAILURE_SCHEMA,
}, ['state', 'root_providers', 'cache']);

const DIAGNOSTIC_SECTION_STATE = ['available', 'unavailable', 'permission_limited', 'failure'];

const DISK_PRESSURE_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable', 'failure'] },
  filesystem_count: { type: ['integer', 'null'], minimum: 0 },
  highest_use_percent: { type: ['number', 'null'], minimum: 0 },
  root_use_percent: { type: ['number', 'null'], minimum: 0 },
  failure: FAILURE_SCHEMA,
}, ['state', 'filesystem_count', 'highest_use_percent', 'root_use_percent']);

const FAILED_SYSTEMD_SCHEMA = objectSchema({
  state: { type: 'string', enum: DIAGNOSTIC_SECTION_STATE },
  count: { type: ['integer', 'null'], minimum: 0 },
  failure: FAILURE_SCHEMA,
}, ['state', 'count']);

const GPU_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'not_applicable', 'failure'] },
  provider: { type: 'string' },
  count: { type: ['integer', 'null'], minimum: 0 },
  failure: FAILURE_SCHEMA,
}, ['state', 'provider', 'count']);

const CAPABILITY_CACHE_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable'] },
  status: { type: ['string', 'null'], enum: ['hit', 'miss', 'refresh', null] },
  ttl_ms: { type: ['integer', 'null'], minimum: 1, maximum: 3_600_000 },
  entries: { type: ['integer', 'null'], minimum: 0 },
  pending: { type: ['integer', 'null'], minimum: 0 },
}, ['state', 'status', 'ttl_ms', 'entries', 'pending']);

const TIMING_BUCKET_SCHEMA = objectSchema({
  le_10_ms: { type: 'integer', minimum: 0 },
  le_50_ms: { type: 'integer', minimum: 0 },
  le_100_ms: { type: 'integer', minimum: 0 },
  le_500_ms: { type: 'integer', minimum: 0 },
  le_1000_ms: { type: 'integer', minimum: 0 },
  gt_1000_ms: { type: 'integer', minimum: 0 },
}, []);

const TIMING_METRIC_SCHEMA = objectSchema({
  count: { type: 'integer', minimum: 0 },
  total_ms: { type: 'number', minimum: 0 },
  min_ms: { type: ['number', 'null'], minimum: 0 },
  max_ms: { type: ['number', 'null'], minimum: 0 },
  average_ms: { type: 'number', minimum: 0 },
  buckets: TIMING_BUCKET_SCHEMA,
}, []);

const TELEMETRY_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable'] },
  timings: objectSchema(
    Object.fromEntries(TELEMETRY_TIMINGS.map((name) => [name, TIMING_METRIC_SCHEMA])),
    [],
  ),
  counters: objectSchema(
    Object.fromEntries(TELEMETRY_COUNTERS.map((name) => [name, { type: 'integer', minimum: 0 }])),
    [],
  ),
}, ['state', 'timings', 'counters']);

const DIAGNOSE_SUCCESS_SCHEMA = objectSchema({
  target: { type: 'string', minLength: 1 },
  state: { type: 'string', enum: ['available', 'degraded', 'failure'] },
  transport: TRANSPORT_SCHEMA,
  remote_identity: REMOTE_IDENTITY_SCHEMA,
  system: SYSTEM_SCHEMA,
  privilege: PRIVILEGE_SCHEMA,
  ai_tmux: objectSchema({
    state: { type: 'string', enum: ['available', 'unavailable'] },
    version: { type: ['string', 'null'] },
  }, ['state', 'version']),
  disk_pressure: DISK_PRESSURE_SCHEMA,
  failed_systemd_units: FAILED_SYSTEMD_SCHEMA,
  gpu: GPU_SCHEMA,
  capabilities: { oneOf: [CAPABILITIES_SCHEMA, { type: 'null' }] },
  capability_cache: CAPABILITY_CACHE_SCHEMA,
  telemetry: TELEMETRY_SCHEMA,
}, [
  'target', 'state', 'transport', 'remote_identity', 'system', 'privilege',
  'ai_tmux', 'disk_pressure', 'failed_systemd_units', 'gpu', 'capabilities',
  'capability_cache', 'telemetry',
]);

export const TARGET_TOOLS = Object.freeze([
  Object.freeze({
    name: 'target_capabilities',
    description: 'Return a bounded cached inventory of remote administration, transfer, diagnostics, ai-tmux and non-interactive privilege capabilities without opening password prompts.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1, description: 'Native OpenSSH host or alias.' },
      refresh: { type: 'boolean', default: false },
    }, ['target']),
    outputSchema: { type: 'object', oneOf: [INVENTORY_SUCCESS_SCHEMA, FAILURE_SCHEMA] },
  }),
  Object.freeze({
    name: 'target_diagnose',
    description: 'Diagnose one OpenSSH target with bounded transport, system, capability, ai-tmux, privilege, cache and aggregate telemetry evidence. The diagnostic remains read-only and does not open password prompts.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1, description: 'Native OpenSSH host or alias.' },
      refresh: { type: 'boolean', default: false },
    }, ['target']),
    outputSchema: { type: 'object', oneOf: [DIAGNOSE_SUCCESS_SCHEMA, FAILURE_SCHEMA] },
  }),
]);

export const TARGET_TOOL_NAMES = new Set(TARGET_TOOLS.map((tool) => tool.name));

function result(value, { isError = false } = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) response.isError = true;
  return response;
}

function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TerminalError('validation_error', 'target capability request must be an object');
  }
  if (typeof args.target !== 'string' || args.target.trim() === '' || args.target.includes('\0')) {
    throw new TerminalError('validation_error', 'target must be a non-empty string without NUL bytes');
  }
  const refresh = args.refresh ?? false;
  if (typeof refresh !== 'boolean') {
    throw new TerminalError('validation_error', 'refresh must be a boolean');
  }
  return { target: args.target, refresh };
}

export async function callTargetTool(
  name,
  args,
  {
    capabilityInventory = defaultCapabilityInventory,
    multiplexManager = null,
    privilegeEngine = null,
    telemetry = terminalTelemetry,
    systemInfoImpl,
    diskUsageImpl,
    gpuInfoImpl,
    remoteExecImpl,
  } = {},
) {
  if (!TARGET_TOOL_NAMES.has(name)) {
    throw new TerminalError('validation_error', `Unknown target tool: ${name}`);
  }
  try {
    const request = validateArgs(args ?? {});
    if (name === 'target_diagnose') {
      return result(await diagnoseTarget(request, {
        capabilityInventory,
        multiplexManager,
        privilegeEngine,
        telemetry,
        systemInfoImpl,
        diskUsageImpl,
        gpuInfoImpl,
        remoteExecImpl,
      }));
    }
    return result(await capabilityInventory.get(request.target, { refresh: request.refresh }));
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}

