import { TerminalError } from './errors.mjs';
import { remoteRootExec } from './root-exec.mjs';
import { terminalTelemetry } from './telemetry.mjs';

const DEFAULT_TTL_MS = 120_000;
const MAX_TTL_MS = 3_600_000;
const PROVIDER_ORDER = Object.freeze([
  'direct_root',
  'sudo_nopasswd',
  'docker_host_root',
  'sudo_password',
  'su_root_password',
]);
const NON_SECRET_PROVIDERS = new Set([
  'direct_root',
  'sudo_nopasswd',
  'docker_host_root',
]);
const SAFE_TARGET = /^[^\s\0-][^\s\0]*$/u;

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TerminalError('validation_error', 'privilege target must be a non-empty OpenSSH host or alias');
  }
  const normalized = target.trim();
  if (!SAFE_TARGET.test(normalized)) {
    throw new TerminalError('validation_error', 'privilege target must be a safe OpenSSH host or alias');
  }
  return normalized;
}

function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TerminalError('validation_error', 'privilege execution request must be an object');
  }
  const target = validateTarget(request.target);
  if (typeof request.command !== 'string' || request.command.trim() === '' || request.command.includes('\0')) {
    throw new TerminalError('validation_error', 'privilege command must be a non-empty string without NUL bytes');
  }
  return { ...request, target };
}

function validateTtl(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError(`ttlMs must be an integer between 1 and ${MAX_TTL_MS}`);
  }
  return ttlMs;
}

function identityKey(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) return 'unknown';
  return JSON.stringify({
    hostname: identity.hostname ?? '',
    user: identity.user ?? '',
    port: identity.port ?? 22,
    proxy_jump: identity.proxy_jump ?? null,
  });
}

function normalizeCapabilityHint(rootProviders) {
  const source = rootProviders && typeof rootProviders === 'object' ? rootProviders : {};
  return Object.freeze(Object.fromEntries(
    PROVIDER_ORDER.map((provider) => [provider, source[provider] === true]),
  ));
}

function preferredOrder(preference) {
  if (!preference) return PROVIDER_ORDER;
  return Object.freeze([
    preference,
    ...PROVIDER_ORDER.filter((provider) => provider !== preference),
  ]);
}

function elapsedMs(now, startedAt) {
  const endedAt = Number(now());
  return Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : 0;
}

export function createPrivilegeEngine({
  ttlMs = DEFAULT_TTL_MS,
  capabilityInventory,
  rootExecImpl = remoteRootExec,
  now = Date.now,
  telemetry = terminalTelemetry,
} = {}) {
  const ttl = validateTtl(ttlMs);
  if (!capabilityInventory?.get) throw new TypeError('capabilityInventory.get must be available');
  if (typeof rootExecImpl !== 'function') throw new TypeError('rootExecImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const cache = new Map();

  async function execute(requestInput, deps = {}) {
    const request = validateRequest(requestInput);
    const startedAt = Number(now());
    try {
      const inventory = await capabilityInventory.get(request.target);
      const capabilities = normalizeCapabilityHint(inventory?.root_providers);
      const currentIdentity = identityKey(inventory?.identity);
      const currentMs = Number(now());
      if (!Number.isFinite(currentMs)) throw new TypeError('now() must return a finite millisecond timestamp');

      let cached = cache.get(request.target) ?? null;
      if (
        cached
        && (
          cached.expiresAtMs <= currentMs
          || cached.identityKey !== currentIdentity
          || capabilities[cached.strategy] !== true
        )
      ) {
        cache.delete(request.target);
        cached = null;
      }

      let executed;
      try {
        executed = await rootExecImpl(request, {
          ...deps,
          providerOrder: preferredOrder(cached?.strategy ?? null),
          capabilityHint: capabilities,
        });
      } catch (error) {
        cache.delete(request.target);
        throw error;
      }

      if (NON_SECRET_PROVIDERS.has(executed?.strategy)) {
        cache.set(request.target, {
          strategy: executed.strategy,
          identityKey: currentIdentity,
          expiresAtMs: currentMs + ttl,
        });
      } else {
        cache.delete(request.target);
      }
      return executed;
    } finally {
      telemetry?.recordTiming?.('root_provider', elapsedMs(now, startedAt));
    }
  }

  function invalidate(targetInput) {
    if (targetInput === undefined) {
      const removed = cache.size;
      cache.clear();
      return removed;
    }
    const target = validateTarget(targetInput);
    return cache.delete(target) ? 1 : 0;
  }

  function snapshot() {
    const providers = {
      direct_root: 0,
      sudo_nopasswd: 0,
      docker_host_root: 0,
    };
    for (const entry of cache.values()) {
      if (entry.strategy in providers) providers[entry.strategy] += 1;
    }
    return Object.freeze({
      ttl_ms: ttl,
      entries: cache.size,
      providers: Object.freeze(providers),
    });
  }

  return Object.freeze({ execute, invalidate, snapshot });
}

