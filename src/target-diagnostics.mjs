import { normalizeFailure, TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';
import { diskUsage, gpuInfo, systemInfo } from './system-helpers.mjs';
import { TELEMETRY_COUNTERS, TELEMETRY_TIMINGS, terminalTelemetry } from './telemetry.mjs';

const FAILED_SYSTEMD_COMMAND = 'systemctl list-units --failed --no-legend --no-pager --plain';
const EMPTY_MULTIPLEX = Object.freeze({
  mode: 'unmanaged',
  state: 'unavailable',
  active: false,
  target_hash: null,
});
const EMPTY_PRIVILEGE_PROVIDERS = Object.freeze({
  direct_root: 0,
  sudo_nopasswd: 0,
  docker_host_root: 0,
});
const TELEMETRY_BUCKETS = Object.freeze([
  'le_10_ms', 'le_50_ms', 'le_100_ms', 'le_500_ms', 'le_1000_ms', 'gt_1000_ms',
]);

function failureView(error) {
  return normalizeFailure(error);
}

function safeSnapshot(fn, fallback) {
  try {
    const value = fn?.();
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function multiplexView(manager, target) {
  try {
    const value = manager?.inspect?.(target);
    if (!value || typeof value !== 'object') return EMPTY_MULTIPLEX;
    return Object.freeze({
      mode: typeof value.mode === 'string' ? value.mode : 'unmanaged',
      state: typeof value.state === 'string' ? value.state : 'unavailable',
      active: Boolean(value.active),
      target_hash: typeof value.target_hash === 'string' ? value.target_hash : null,
    });
  } catch {
    return EMPTY_MULTIPLEX;
  }
}

function privilegeState(rootProviders) {
  if (!rootProviders || typeof rootProviders !== 'object') return 'unavailable';
  if (rootProviders.direct_root || rootProviders.sudo_nopasswd || rootProviders.docker_host_root) return 'available';
  if (rootProviders.sudo_password || rootProviders.su_root_password) return 'permission_limited';
  return 'unavailable';
}

function privilegeCacheView(privilegeEngine) {
  const snapshot = safeSnapshot(() => privilegeEngine?.snapshot?.(), null);
  if (!snapshot) {
    return Object.freeze({
      state: 'unavailable',
      ttl_ms: null,
      entries: null,
      providers: EMPTY_PRIVILEGE_PROVIDERS,
    });
  }
  const providers = snapshot.providers && typeof snapshot.providers === 'object'
    ? snapshot.providers
    : {};
  return Object.freeze({
    state: 'available',
    ttl_ms: Number.isInteger(snapshot.ttl_ms) ? snapshot.ttl_ms : null,
    entries: Number.isInteger(snapshot.entries) ? snapshot.entries : null,
    providers: Object.freeze({
      direct_root: Number.isInteger(providers.direct_root) ? providers.direct_root : 0,
      sudo_nopasswd: Number.isInteger(providers.sudo_nopasswd) ? providers.sudo_nopasswd : 0,
      docker_host_root: Number.isInteger(providers.docker_host_root) ? providers.docker_host_root : 0,
    }),
  });
}

function capabilityCacheView(inventoryResult, capabilityInventory) {
  const snapshot = safeSnapshot(() => capabilityInventory?.snapshot?.(), null);
  return Object.freeze({
    state: snapshot ? 'available' : 'unavailable',
    status: typeof inventoryResult?.cache?.status === 'string' ? inventoryResult.cache.status : null,
    ttl_ms: Number.isInteger(inventoryResult?.cache?.ttl_ms)
      ? inventoryResult.cache.ttl_ms
      : (Number.isInteger(snapshot?.ttl_ms) ? snapshot.ttl_ms : null),
    entries: Number.isInteger(snapshot?.entries) ? snapshot.entries : null,
    pending: Number.isInteger(snapshot?.pending) ? snapshot.pending : null,
  });
}

function telemetryView(telemetry) {
  const snapshot = safeSnapshot(() => telemetry?.snapshot?.(), null);
  if (!snapshot) return Object.freeze({ state: 'unavailable', timings: Object.freeze({}), counters: Object.freeze({}) });
  const sourceTimings = snapshot.timings && typeof snapshot.timings === 'object' ? snapshot.timings : {};
  const sourceCounters = snapshot.counters && typeof snapshot.counters === 'object' ? snapshot.counters : {};
  const timings = {};
  for (const name of TELEMETRY_TIMINGS) {
    const metric = sourceTimings[name];
    if (!metric || typeof metric !== 'object') continue;
    const normalized = {};
    if (Number.isInteger(metric.count) && metric.count >= 0) normalized.count = metric.count;
    for (const field of ['total_ms', 'average_ms']) {
      if (typeof metric[field] === 'number' && Number.isFinite(metric[field]) && metric[field] >= 0) {
        normalized[field] = metric[field];
      }
    }
    for (const field of ['min_ms', 'max_ms']) {
      if (metric[field] === null) normalized[field] = null;
      else if (typeof metric[field] === 'number' && Number.isFinite(metric[field]) && metric[field] >= 0) {
        normalized[field] = metric[field];
      }
    }
    if (metric.buckets && typeof metric.buckets === 'object') {
      const buckets = {};
      for (const bucket of TELEMETRY_BUCKETS) {
        if (Number.isInteger(metric.buckets[bucket]) && metric.buckets[bucket] >= 0) {
          buckets[bucket] = metric.buckets[bucket];
        }
      }
      normalized.buckets = Object.freeze(buckets);
    }
    timings[name] = Object.freeze(normalized);
  }
  const counters = {};
  for (const name of TELEMETRY_COUNTERS) {
    if (Number.isInteger(sourceCounters[name]) && sourceCounters[name] >= 0) counters[name] = sourceCounters[name];
  }
  return Object.freeze({
    state: 'available',
    timings: Object.freeze(timings),
    counters: Object.freeze(counters),
  });
}

function systemView(value) {
  return Object.freeze({
    state: 'available',
    hostname: value.hostname ?? '',
    kernel: value.kernel ?? '',
    architecture: value.architecture ?? '',
    os: Object.freeze({
      id: value.os?.id ?? '',
      version: value.os?.version ?? '',
      pretty_name: value.os?.pretty_name ?? '',
    }),
    uptime_seconds: Number.isFinite(value.uptime_seconds) ? value.uptime_seconds : 0,
  });
}

function unavailableDiskPressure() {
  return Object.freeze({
    state: 'unavailable',
    filesystem_count: null,
    highest_use_percent: null,
    root_use_percent: null,
  });
}

function percent(used, size) {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0 || used < 0) return 0;
  return Number(((used / size) * 100).toFixed(3));
}

export function diskPressureView(value) {
  const filesystems = Array.isArray(value?.filesystems) ? value.filesystems : [];
  let highest = 0;
  let root = null;
  for (const filesystem of filesystems) {
    const use = percent(filesystem?.used_bytes, filesystem?.size_bytes);
    highest = Math.max(highest, use);
    if (filesystem?.mountpoint === '/') root = use;
  }
  return Object.freeze({
    state: 'available',
    filesystem_count: filesystems.length,
    highest_use_percent: filesystems.length > 0 ? highest : 0,
    root_use_percent: root,
  });
}

function gpuAvailableView(value) {
  if (value?.available !== true) {
    return Object.freeze({ state: 'not_applicable', provider: 'nvidia-smi', count: 0 });
  }
  return Object.freeze({
    state: 'available',
    provider: typeof value.provider === 'string' ? value.provider : 'nvidia-smi',
    count: Array.isArray(value.gpus) ? value.gpus.length : 0,
  });
}

function permissionText(text) {
  return /permission denied|operation not permitted|access denied|authentication required|interactive authentication required/iu
    .test(text ?? '');
}

async function failedSystemdUnits(target, remoteExecImpl) {
  let executed;
  try {
    executed = await remoteExecImpl({
      target,
      command: FAILED_SYSTEMD_COMMAND,
      env: { LC_ALL: 'C' },
      timeout_ms: 10_000,
      max_output_bytes: 65_536,
    });
  } catch (error) {
    const failure = failureView(error);
    if (failure.category === 'permission_privilege_error') {
      return Object.freeze({ state: 'permission_limited', count: null });
    }
    return Object.freeze({ state: 'failure', count: null, failure });
  }
  if (executed?.timed_out) {
    return Object.freeze({
      state: 'failure', count: null,
      failure: failureView(new TerminalError('timeout', 'failed systemd unit probe timed out', { retryable: true })),
    });
  }
  if (executed?.truncated) {
    return Object.freeze({
      state: 'failure', count: null,
      failure: failureView(new TerminalError('local_capability_dependency_error', 'failed systemd unit probe exceeded its bounded output contract')),
    });
  }
  if (executed?.exit_code !== 0) {
    if (permissionText(executed?.stderr)) return Object.freeze({ state: 'permission_limited', count: null });
    return Object.freeze({
      state: 'failure', count: null,
      failure: failureView(new TerminalError(
        'remote_command_nonzero_exit',
        `failed systemd unit probe exited with status ${executed?.exit_code}`,
        { details: { exit_code: executed?.exit_code } },
      )),
    });
  }
  const count = String(executed?.stdout ?? '').split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
  return Object.freeze({ state: 'available', count });
}

function failedView(error) {
  return Object.freeze({ state: 'failure', failure: failureView(error) });
}

function settledView(settled, availableMapper) {
  return settled.status === 'fulfilled' ? availableMapper(settled.value) : failedView(settled.reason);
}

function diagnosticFailureResult({ target, error, multiplex, telemetry, capabilityCache, privilegeCache }) {
  return Object.freeze({
    target,
    state: 'failure',
    transport: Object.freeze({ state: 'failure', failure: failureView(error), multiplex }),
    remote_identity: Object.freeze({ state: 'unavailable' }),
    system: Object.freeze({ state: 'unavailable' }),
    privilege: Object.freeze({ state: 'unavailable', root_providers: null, cache: privilegeCache }),
    ai_tmux: Object.freeze({ state: 'unavailable', version: null }),
    disk_pressure: unavailableDiskPressure(),
    failed_systemd_units: Object.freeze({ state: 'unavailable', count: null }),
    gpu: Object.freeze({ state: 'not_applicable', provider: 'nvidia-smi', count: 0 }),
    capabilities: null,
    capability_cache: capabilityCache,
    telemetry,
  });
}

export async function diagnoseTarget(
  request,
  {
    capabilityInventory,
    multiplexManager,
    privilegeEngine,
    telemetry = terminalTelemetry,
    remoteExecImpl = remoteExec,
    systemInfoImpl = systemInfo,
    diskUsageImpl = diskUsage,
    gpuInfoImpl = gpuInfo,
  } = {},
) {
  const target = request?.target;
  const refresh = request?.refresh ?? false;
  const multiplex = multiplexView(multiplexManager, target);
  const telemetryEvidence = telemetryView(telemetry);
  const privilegeCache = privilegeCacheView(privilegeEngine);

  let inventoryResult;
  try {
    if (!capabilityInventory || typeof capabilityInventory.get !== 'function') {
      throw new TerminalError('local_capability_dependency_error', 'target capability inventory is unavailable');
    }
    inventoryResult = await capabilityInventory.get(target, { refresh });
  } catch (error) {
    return diagnosticFailureResult({
      target,
      error,
      multiplex,
      telemetry: telemetryEvidence,
      capabilityCache: capabilityCacheView(null, capabilityInventory),
      privilegeCache,
    });
  }

  const capabilityCache = capabilityCacheView(inventoryResult, capabilityInventory);
  const systemctlAvailable = inventoryResult.capabilities?.systemctl?.available === true;
  const gpuAvailable = inventoryResult.capabilities?.['nvidia-smi']?.available === true;

  const [systemSettled, diskSettled, failedUnitsSettled, gpuSettled] = await Promise.allSettled([
    systemInfoImpl({ target }, { remoteExecImpl }),
    diskUsageImpl({ target }, { remoteExecImpl }),
    systemctlAvailable
      ? failedSystemdUnits(target, remoteExecImpl)
      : Promise.resolve(Object.freeze({ state: 'unavailable', count: null })),
    gpuAvailable
      ? gpuInfoImpl({ target }, { remoteExecImpl })
      : Promise.resolve(Object.freeze({ available: false, provider: 'nvidia-smi', gpus: [] })),
  ]);

  const system = settledView(systemSettled, systemView);
  const diskPressure = diskSettled.status === 'fulfilled'
    ? diskPressureView(diskSettled.value)
    : Object.freeze({
      state: 'failure',
      filesystem_count: null,
      highest_use_percent: null,
      root_use_percent: null,
      failure: failureView(diskSettled.reason),
    });
  const failedUnits = failedUnitsSettled.status === 'fulfilled'
    ? failedUnitsSettled.value
    : Object.freeze({ state: 'failure', count: null, failure: failureView(failedUnitsSettled.reason) });
  const gpu = gpuSettled.status === 'fulfilled'
    ? gpuAvailableView(gpuSettled.value)
    : Object.freeze({ state: 'failure', provider: 'nvidia-smi', count: null, failure: failureView(gpuSettled.reason) });

  const degraded = [system, diskPressure, failedUnits, gpu].some((section) => section.state === 'failure');
  const rootProviders = inventoryResult.root_providers ?? null;
  const ai = inventoryResult.capabilities?.['ai-tmux'];

  return Object.freeze({
    target,
    state: degraded ? 'degraded' : 'available',
    transport: Object.freeze({
      state: 'available',
      identity: inventoryResult.identity,
      multiplex,
    }),
    remote_identity: Object.freeze({
      state: 'available',
      user: inventoryResult.user,
      uid: inventoryResult.uid,
    }),
    system,
    privilege: Object.freeze({
      state: privilegeState(rootProviders),
      root_providers: rootProviders,
      cache: privilegeCache,
    }),
    ai_tmux: Object.freeze({
      state: ai?.available ? 'available' : 'unavailable',
      version: ai?.available ? (ai.version ?? null) : null,
    }),
    disk_pressure: diskPressure,
    failed_systemd_units: failedUnits,
    gpu,
    capabilities: inventoryResult.capabilities,
    capability_cache: capabilityCache,
    telemetry: telemetryEvidence,
  });
}

