import { terminalDiagnostics } from './diagnostics.mjs';
import { normalizeFailure, TerminalError } from './errors.mjs';
import { checkForwardHealth } from './forward-tools.mjs';
import { remoteExec } from './remote-exec.mjs';
import { createStateStore } from './state-store.mjs';
import { TELEMETRY_COUNTERS, TELEMETRY_TIMINGS } from './telemetry.mjs';
import { resolveTarget } from './target-resolver.mjs';
import { PtyUpstreamClient } from './upstream-pty.mjs';
import { VERSION } from './version.mjs';

const DEFAULT_GATEWAY_HEALTH_URL = 'http://127.0.0.1:9022/healthz';
const defaultStateStore = createStateStore();
const defaultUpstreamClient = new PtyUpstreamClient();
const ACTIVE_TASK_STATES = new Set(['queued', 'running']);
const TELEMETRY_BUCKET_NAMES = Object.freeze([
  'le_10_ms', 'le_50_ms', 'le_100_ms', 'le_500_ms', 'le_1000_ms', 'gt_1000_ms',
]);

function failureSchema() {
  return {
    type: 'object',
    properties: {
      category: { type: 'string' },
      message: { type: 'string' },
      retryable: { type: 'boolean' },
      details: {},
    },
    required: ['category', 'message', 'retryable'],
    additionalProperties: false,
  };
}

const HEALTH_COUNT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    known: { type: 'integer', minimum: 0 },
    active: { type: 'integer', minimum: 0 },
  },
  required: ['known', 'active'],
  additionalProperties: false,
});

const RECONNECT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    attempts: { type: 'integer', minimum: 0 },
    successes: { type: 'integer', minimum: 0 },
    failures: { type: 'integer', minimum: 0 },
  },
  required: ['attempts', 'successes', 'failures'],
  additionalProperties: false,
});

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TELEMETRY_BUCKET_SCHEMA = objectSchema({
  le_10_ms: { type: 'integer', minimum: 0 },
  le_50_ms: { type: 'integer', minimum: 0 },
  le_100_ms: { type: 'integer', minimum: 0 },
  le_500_ms: { type: 'integer', minimum: 0 },
  le_1000_ms: { type: 'integer', minimum: 0 },
  gt_1000_ms: { type: 'integer', minimum: 0 },
});

const TELEMETRY_METRIC_SCHEMA = objectSchema({
  count: { type: 'integer', minimum: 0 },
  total_ms: { type: 'number', minimum: 0 },
  min_ms: { type: ['number', 'null'], minimum: 0 },
  max_ms: { type: ['number', 'null'], minimum: 0 },
  average_ms: { type: 'number', minimum: 0 },
  buckets: TELEMETRY_BUCKET_SCHEMA,
});

const RUNTIME_TELEMETRY_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable'] },
  timings: objectSchema(Object.fromEntries(
    TELEMETRY_TIMINGS.map((name) => [name, TELEMETRY_METRIC_SCHEMA]),
  )),
  counters: objectSchema(Object.fromEntries(
    TELEMETRY_COUNTERS.map((name) => [name, { type: 'integer', minimum: 0 }]),
  )),
}, ['state', 'timings', 'counters']);

const RUNTIME_MULTIPLEX_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable'] },
  mode: { type: 'string', enum: ['off', 'auto', 'required', 'unmanaged'] },
  active_masters: { type: ['integer', 'null'], minimum: 0 },
}, ['state', 'mode', 'active_masters']);

const RUNTIME_CAPABILITY_CACHE_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable'] },
  entries: { type: ['integer', 'null'], minimum: 0 },
  pending: { type: ['integer', 'null'], minimum: 0 },
  ttl_ms: { type: ['integer', 'null'], minimum: 1, maximum: 3_600_000 },
}, ['state', 'entries', 'pending', 'ttl_ms']);

const RUNTIME_PRIVILEGE_CACHE_SCHEMA = objectSchema({
  state: { type: 'string', enum: ['available', 'unavailable'] },
  ttl_ms: { type: ['integer', 'null'], minimum: 1, maximum: 3_600_000 },
  entries: { type: ['integer', 'null'], minimum: 0 },
  providers: objectSchema({
    direct_root: { type: 'integer', minimum: 0 },
    sudo_nopasswd: { type: 'integer', minimum: 0 },
    docker_host_root: { type: 'integer', minimum: 0 },
  }, ['direct_root', 'sudo_nopasswd', 'docker_host_root']),
}, ['state', 'ttl_ms', 'entries', 'providers']);

const RUNTIME_SCHEMA = objectSchema({
  telemetry: RUNTIME_TELEMETRY_SCHEMA,
  multiplex: RUNTIME_MULTIPLEX_SCHEMA,
  capability_cache: RUNTIME_CAPABILITY_CACHE_SCHEMA,
  privilege_cache: RUNTIME_PRIVILEGE_CACHE_SCHEMA,
}, ['telemetry', 'multiplex', 'capability_cache', 'privilege_cache']);

const HEALTH_SUCCESS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    extension: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        healthy: { type: 'boolean' },
      },
      required: ['version', 'healthy'],
      additionalProperties: false,
    },
    upstream: {
      type: 'object',
      properties: {
        healthy: { type: 'boolean' },
        version: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: {
                name: { type: 'string' },
                version: { type: 'string' },
              },
              required: ['name', 'version'],
              additionalProperties: false,
            },
          ],
        },
        tool_count: { type: 'integer', minimum: 0 },
      },
      required: ['healthy', 'version', 'tool_count'],
      additionalProperties: false,
    },
    gateway: {
      type: 'object',
      properties: {
        healthy: { type: 'boolean' },
        url: { type: 'string' },
      },
      required: ['healthy', 'url'],
      additionalProperties: false,
    },
    counts: {
      type: 'object',
      properties: {
        sessions: HEALTH_COUNT_SCHEMA,
        tasks: HEALTH_COUNT_SCHEMA,
        forwards: HEALTH_COUNT_SCHEMA,
      },
      required: ['sessions', 'tasks', 'forwards'],
      additionalProperties: false,
    },
    targets: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          ai_tmux: {
            type: 'object',
            properties: {
              available: { type: 'boolean' },
              version: { type: ['string', 'null'] },
              compatible: { type: 'boolean' },
            },
            required: ['available', 'version', 'compatible'],
            additionalProperties: false,
          },
          remote_sessions: { type: ['integer', 'null'], minimum: 0 },
        },
        required: ['target', 'ai_tmux'],
        additionalProperties: false,
      },
    },
    diagnostics: {
      type: 'object',
      properties: {
        reconnect: RECONNECT_SCHEMA,
        failures: {
          type: 'object',
          properties: {
            total: { type: 'integer', minimum: 0 },
            by_category: {
              type: 'object',
              additionalProperties: { type: 'integer', minimum: 0 },
            },
          },
          required: ['total', 'by_category'],
          additionalProperties: false,
        },
      },
      required: ['reconnect', 'failures'],
      additionalProperties: false,
    },
    runtime: RUNTIME_SCHEMA,
  },
  required: ['extension', 'upstream', 'gateway', 'counts', 'targets', 'diagnostics', 'runtime'],
  additionalProperties: false,
});

export const TERMINAL_HEALTH_TOOL = Object.freeze({
  name: 'terminal_health',
  description: 'Return bounded non-secret health, lifecycle counts, reconnect/failure counters, gateway status, and optional ai-tmux/remote-session compatibility for requested targets.',
  inputSchema: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', minLength: 1 },
        default: [],
      },
      include_remote_sessions: { type: 'boolean', default: false },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    oneOf: [
      HEALTH_SUCCESS_SCHEMA,
      failureSchema(),
    ],
  },
});

function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TerminalError('validation_error', 'terminal_health request must be an object');
  }
  const targets = request.targets ?? [];
  if (!Array.isArray(targets) || targets.length > 10) {
    throw new TerminalError('validation_error', 'targets must be an array with at most 10 entries');
  }
  if (targets.some((target) => typeof target !== 'string' || target.trim() === '' || target.includes('\0'))) {
    throw new TerminalError('validation_error', 'each target must be a non-empty string without NUL bytes');
  }
  if (request.include_remote_sessions !== undefined && typeof request.include_remote_sessions !== 'boolean') {
    throw new TerminalError('validation_error', 'include_remote_sessions must be boolean');
  }
  return {
    targets: [...new Set(targets.map((target) => target.trim()))],
    includeRemoteSessions: request.include_remote_sessions ?? false,
  };
}

function parseToolJson(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function sessionAlive(upstreamClient, localSessionId) {
  if (typeof localSessionId !== 'string' || localSessionId.length === 0) return false;
  try {
    const parsed = parseToolJson(await upstreamClient.callTool('get_session_state', {
      session_id: localSessionId,
    }));
    return parsed?.is_alive === true;
  } catch {
    return false;
  }
}

async function gatewayHealth(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
    if (!response?.ok) return false;
    const payload = await response.json();
    return payload?.ok === true;
  } catch {
    return false;
  }
}

function aiTmuxResult(execution) {
  if (!execution || execution.timed_out || execution.exit_code !== 0 || execution.truncated) {
    return { available: false, version: null, compatible: false };
  }
  const version = String(execution.stdout ?? '').trim().split(/\r?\n/u)[0] || null;
  return {
    available: version !== null,
    version,
    compatible: version !== null,
  };
}

function safeSnapshot(source) {
  try {
    const value = source?.snapshot?.();
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function runtimeTelemetry(source) {
  const snapshot = safeSnapshot(source);
  if (!snapshot) return { state: 'unavailable', timings: {}, counters: {} };
  const timings = {};
  const sourceTimings = snapshot.timings && typeof snapshot.timings === 'object' ? snapshot.timings : {};
  for (const name of TELEMETRY_TIMINGS) {
    const metric = sourceTimings[name];
    if (!metric || typeof metric !== 'object') continue;
    const normalized = {};
    if (Number.isInteger(metric.count) && metric.count >= 0) normalized.count = metric.count;
    for (const field of ['total_ms', 'average_ms']) {
      if (typeof metric[field] === 'number' && Number.isFinite(metric[field]) && metric[field] >= 0) normalized[field] = metric[field];
    }
    for (const field of ['min_ms', 'max_ms']) {
      if (metric[field] === null) normalized[field] = null;
      else if (typeof metric[field] === 'number' && Number.isFinite(metric[field]) && metric[field] >= 0) normalized[field] = metric[field];
    }
    if (metric.buckets && typeof metric.buckets === 'object') {
      const buckets = {};
      for (const bucket of TELEMETRY_BUCKET_NAMES) {
        if (Number.isInteger(metric.buckets[bucket]) && metric.buckets[bucket] >= 0) buckets[bucket] = metric.buckets[bucket];
      }
      normalized.buckets = buckets;
    }
    timings[name] = normalized;
  }
  const counters = {};
  const sourceCounters = snapshot.counters && typeof snapshot.counters === 'object' ? snapshot.counters : {};
  for (const name of TELEMETRY_COUNTERS) {
    if (Number.isInteger(sourceCounters[name]) && sourceCounters[name] >= 0) counters[name] = sourceCounters[name];
  }
  return { state: 'available', timings, counters };
}

function runtimeMultiplex(source) {
  const snapshot = safeSnapshot(source);
  if (!snapshot) return { state: 'unavailable', mode: 'unmanaged', active_masters: null };
  const mode = ['off', 'auto', 'required'].includes(snapshot.mode) ? snapshot.mode : 'unmanaged';
  return {
    state: 'available',
    mode,
    active_masters: Number.isInteger(snapshot.active_masters) && snapshot.active_masters >= 0
      ? snapshot.active_masters
      : null,
  };
}

function runtimeCapabilityCache(source) {
  const snapshot = safeSnapshot(source);
  if (!snapshot) return { state: 'unavailable', entries: null, pending: null, ttl_ms: null };
  return {
    state: 'available',
    entries: Number.isInteger(snapshot.entries) && snapshot.entries >= 0 ? snapshot.entries : null,
    pending: Number.isInteger(snapshot.pending) && snapshot.pending >= 0 ? snapshot.pending : null,
    ttl_ms: Number.isInteger(snapshot.ttl_ms) && snapshot.ttl_ms > 0 ? snapshot.ttl_ms : null,
  };
}

function runtimePrivilegeCache(source) {
  const snapshot = safeSnapshot(source);
  if (!snapshot) {
    return {
      state: 'unavailable', ttl_ms: null, entries: null,
      providers: { direct_root: 0, sudo_nopasswd: 0, docker_host_root: 0 },
    };
  }
  const providers = snapshot.providers && typeof snapshot.providers === 'object' ? snapshot.providers : {};
  return {
    state: 'available',
    ttl_ms: Number.isInteger(snapshot.ttl_ms) && snapshot.ttl_ms > 0 ? snapshot.ttl_ms : null,
    entries: Number.isInteger(snapshot.entries) && snapshot.entries >= 0 ? snapshot.entries : null,
    providers: {
      direct_root: Number.isInteger(providers.direct_root) && providers.direct_root >= 0 ? providers.direct_root : 0,
      sudo_nopasswd: Number.isInteger(providers.sudo_nopasswd) && providers.sudo_nopasswd >= 0 ? providers.sudo_nopasswd : 0,
      docker_host_root: Number.isInteger(providers.docker_host_root) && providers.docker_host_root >= 0 ? providers.docker_host_root : 0,
    },
  };
}

function runtimeView({ telemetry, multiplexManager, capabilityInventory, privilegeEngine }) {
  return {
    telemetry: runtimeTelemetry(telemetry),
    multiplex: runtimeMultiplex(multiplexManager),
    capability_cache: runtimeCapabilityCache(capabilityInventory),
    privilege_cache: runtimePrivilegeCache(privilegeEngine),
  };
}

async function inspectTarget(
  target,
  includeRemoteSessions,
  { upstreamClient, resolveTargetImpl, remoteExecImpl },
) {
  let resolved;
  try {
    resolved = await resolveTargetImpl(target);
  } catch {
    return {
      target,
      ai_tmux: { available: false, version: null, compatible: false },
      ...(includeRemoteSessions ? { remote_sessions: null } : {}),
    };
  }

  let aiTmux;
  try {
    aiTmux = aiTmuxResult(await remoteExecImpl({
      target,
      command: 'command -v ai-tmux >/dev/null 2>&1 && ai-tmux --version',
      env: { LC_ALL: 'C' },
      timeout_ms: 5_000,
      max_output_bytes: 16_384,
    }));
  } catch {
    aiTmux = { available: false, version: null, compatible: false };
  }

  const result = { target, ai_tmux: aiTmux };
  if (includeRemoteSessions) {
    try {
      const remote = parseToolJson(await upstreamClient.callTool('list_remote_sessions', {
        host: resolved.alias ?? target,
        user: resolved.user,
      }));
      result.remote_sessions = Array.isArray(remote)
        ? remote.filter((entry) => entry?.is_alive !== false).length
        : null;
    } catch {
      result.remote_sessions = null;
    }
  }
  return result;
}

export async function getTerminalHealth(
  request = {},
  {
    extensionVersion = VERSION,
    diagnostics = terminalDiagnostics,
    upstreamClient = defaultUpstreamClient,
    stateStore = defaultStateStore,
    forwardHealthImpl = checkForwardHealth,
    resolveTargetImpl = resolveTarget,
    remoteExecImpl = remoteExec,
    fetchImpl = fetch,
    gatewayHealthUrl = DEFAULT_GATEWAY_HEALTH_URL,
    telemetry = null,
    multiplexManager = null,
    capabilityInventory = null,
    privilegeEngine = null,
  } = {},
) {
  const { targets, includeRemoteSessions } = validateRequest(request);

  let upstreamHealthy = false;
  let upstreamVersion = null;
  let upstreamToolCount = 0;
  try {
    const listed = await upstreamClient.listTools();
    const tools = Array.isArray(listed) ? listed : listed?.tools;
    if (!Array.isArray(tools)) throw new Error('upstream tools/list did not contain tools');
    upstreamHealthy = true;
    upstreamToolCount = tools.length;
    const rawVersion = upstreamClient.getServerVersion?.() ?? null;
    upstreamVersion = rawVersion
      && typeof rawVersion.name === 'string'
      && typeof rawVersion.version === 'string'
      ? { name: rawVersion.name, version: rawVersion.version }
      : null;
  } catch {
    upstreamHealthy = false;
  }

  const state = await stateStore.read();
  const sessions = Object.values(state.sessions ?? {});
  const tasks = Object.values(state.tasks ?? {});
  const forwards = Object.values(state.forwards ?? {});

  let activeSessions = 0;
  if (upstreamHealthy) {
    const active = await Promise.all(sessions.map((entry) => (
      sessionAlive(upstreamClient, entry.local_session_id)
    )));
    activeSessions = active.filter(Boolean).length;
  }

  let activeForwards = 0;
  for (const forward of forwards) {
    try {
      const health = await forwardHealthImpl(forward);
      if (health?.state === 'healthy') activeForwards += 1;
    } catch {
      // Health diagnostics remain best-effort and never expose forward internals.
    }
  }

  const targetResults = [];
  for (const target of targets) {
    targetResults.push(await inspectTarget(target, includeRemoteSessions, {
      upstreamClient,
      resolveTargetImpl,
      remoteExecImpl,
    }));
  }

  return {
    extension: { version: extensionVersion, healthy: true },
    upstream: {
      healthy: upstreamHealthy,
      version: upstreamVersion,
      tool_count: upstreamToolCount,
    },
    gateway: {
      healthy: await gatewayHealth(fetchImpl, gatewayHealthUrl),
      url: gatewayHealthUrl,
    },
    counts: {
      sessions: { known: sessions.length, active: activeSessions },
      tasks: {
        known: tasks.length,
        active: tasks.filter((task) => ACTIVE_TASK_STATES.has(task?.state)).length,
      },
      forwards: { known: forwards.length, active: activeForwards },
    },
    targets: targetResults,
    diagnostics: diagnostics.snapshot(),
    runtime: runtimeView({ telemetry, multiplexManager, capabilityInventory, privilegeEngine }),
  };
}

function response(value, { isError = false } = {}) {
  const result = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) result.isError = true;
  return result;
}

export async function callTerminalHealthTool(
  args,
  { healthImpl = getTerminalHealth, ...deps } = {},
) {
  try {
    return response(await healthImpl(args ?? {}, deps));
  } catch (error) {
    return response(normalizeFailure(error), { isError: true });
  }
}

