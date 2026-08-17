import { createHash } from 'node:crypto';

import { readCapabilityCacheConfig } from './config.mjs';
import { TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';
import { resolveTarget } from './target-resolver.mjs';
import { terminalTelemetry } from './telemetry.mjs';

export const TARGET_CAPABILITY_NAMES = Object.freeze([
  'python3',
  'rsync',
  'sudo',
  'docker',
  'su',
  'systemctl',
  'journalctl',
  'ss',
  'nvidia-smi',
  'curl',
  'openssl',
  'dig',
  'getent',
  'ip',
  'traceroute',
  'mtr',
  'ai-tmux',
]);

export const ROOT_PROVIDER_NAMES = Object.freeze([
  'direct_root',
  'sudo_nopasswd',
  'docker_host_root',
  'sudo_password',
  'su_root_password',
]);

const CAPABILITY_SET = new Set(TARGET_CAPABILITY_NAMES);
const ROOT_PROVIDER_SET = new Set(ROOT_PROVIDER_NAMES);
const SAFE_TARGET = /^[^\s\0-][^\s\0]*$/u;
const MAX_VERSION_CHARS = 240;

export const CAPABILITY_PROBE_COMMAND = String.raw`set +e
ptext_clean() { tr '\r\n=' '   ' | cut -c 1-160; }
ptext_version() {
  case "$1" in
    python3) python3 --version 2>&1 ;;
    rsync) rsync --version 2>&1 | head -n 1 ;;
    sudo) sudo --version 2>&1 | head -n 1 ;;
    docker) docker --version 2>&1 | head -n 1 ;;
    su) su --version 2>&1 | head -n 1 ;;
    systemctl) systemctl --version 2>&1 | head -n 1 ;;
    journalctl) journalctl --version 2>&1 | head -n 1 ;;
    ss) ss -V 2>&1 | head -n 1 ;;
    nvidia-smi) nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 ;;
    curl) curl --version 2>&1 | head -n 1 ;;
    openssl) openssl version 2>&1 | head -n 1 ;;
    dig) dig -v 2>&1 | head -n 1 ;;
    getent) getent --version 2>&1 | head -n 1 ;;
    ip) ip -V 2>&1 | head -n 1 ;;
    traceroute) traceroute --version 2>&1 | head -n 1 ;;
    mtr) mtr --version 2>&1 | head -n 1 ;;
    ai-tmux) ai-tmux --version 2>&1 | head -n 1 ;;
  esac | ptext_clean
}
ptext_cap() {
  ptext_name="$1"
  ptext_cmd="$2"
  if command -v "$ptext_cmd" >/dev/null 2>&1; then
    printf 'cap.%s.available=1\n' "$ptext_name"
    ptext_ver="$(ptext_version "$ptext_name")"
    if [ -n "$ptext_ver" ]; then printf 'cap.%s.version=%s\n' "$ptext_name" "$ptext_ver"; fi
  else
    printf 'cap.%s.available=0\n' "$ptext_name"
  fi
}
ptext_uid="$(id -u 2>/dev/null)"
ptext_user="$(id -un 2>/dev/null | ptext_clean)"
printf 'protocol=1\nuid=%s\nuser=%s\n' "$ptext_uid" "$ptext_user"
ptext_cap python3 python3
ptext_cap rsync rsync
ptext_cap sudo sudo
ptext_cap docker docker
ptext_cap su su
ptext_cap systemctl systemctl
ptext_cap journalctl journalctl
ptext_cap ss ss
ptext_cap nvidia-smi nvidia-smi
ptext_cap curl curl
ptext_cap openssl openssl
ptext_cap dig dig
ptext_cap getent getent
ptext_cap ip ip
ptext_cap traceroute traceroute
ptext_cap mtr mtr
ptext_cap ai-tmux ai-tmux
if [ "$ptext_uid" = '0' ]; then printf 'root.direct_root=1\n'; else printf 'root.direct_root=0\n'; fi
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then printf 'root.sudo_nopasswd=1\n'; else printf 'root.sudo_nopasswd=0\n'; fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ptext_docker_security="$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null | ptext_clean)"
  case "$ptext_docker_security" in *rootless*) printf 'root.docker_host_root=0\n' ;; *) printf 'root.docker_host_root=1\n' ;; esac
else
  printf 'root.docker_host_root=0\n'
fi
if [ "$ptext_uid" != '0' ] && command -v sudo >/dev/null 2>&1; then printf 'root.sudo_password=1\n'; else printf 'root.sudo_password=0\n'; fi
if [ "$ptext_uid" != '0' ] && command -v su >/dev/null 2>&1; then printf 'root.su_root_password=1\n'; else printf 'root.su_root_password=0\n'; fi`;

function validateTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty OpenSSH host or alias');
  }
  const normalized = target.trim();
  if (!SAFE_TARGET.test(normalized)) {
    throw new TerminalError('validation_error', 'target must be a safe OpenSSH host or alias without whitespace or NUL bytes');
  }
  return normalized;
}

function normalizedProxyJump(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().toLowerCase() === 'none') return null;
  return value.trim();
}

function publicIdentity(target, resolved) {
  const user = typeof resolved?.user === 'string' ? resolved.user : '';
  const hostname = typeof resolved?.hostname === 'string' && resolved.hostname.length > 0
    ? resolved.hostname
    : target;
  const port = Number.isInteger(resolved?.port) && resolved.port > 0 ? resolved.port : 22;
  return Object.freeze({
    hostname,
    user,
    port,
    proxy_jump: normalizedProxyJump(resolved?.proxyJump),
  });
}

function identityFingerprint(target, identity) {
  return createHash('sha256').update(JSON.stringify({ target, ...identity })).digest('hex');
}

function emptyCapabilities() {
  return Object.fromEntries(TARGET_CAPABILITY_NAMES.map((name) => [
    name,
    { available: false, version: null },
  ]));
}

function emptyRootProviders() {
  return Object.fromEntries(ROOT_PROVIDER_NAMES.map((name) => [name, false]));
}

function cleanValue(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TerminalError('local_capability_dependency_error', 'capability probe returned invalid text');
  }
  return value.slice(0, MAX_VERSION_CHARS);
}

function parseProbe(text) {
  if (typeof text !== 'string') {
    throw new TerminalError('local_capability_dependency_error', 'capability probe did not return text output');
  }
  const fields = new Map();
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine === '') continue;
    const separator = rawLine.indexOf('=');
    if (separator < 1) continue;
    const key = rawLine.slice(0, separator);
    const value = cleanValue(rawLine.slice(separator + 1));
    fields.set(key, value);
  }

  if (fields.get('protocol') !== '1') {
    throw new TerminalError('local_capability_dependency_error', 'capability probe protocol mismatch');
  }
  const uidText = fields.get('uid') ?? '';
  if (!/^[0-9]+$/u.test(uidText)) {
    throw new TerminalError('local_capability_dependency_error', 'capability probe returned invalid uid');
  }
  const uid = Number.parseInt(uidText, 10);
  const user = fields.get('user') ?? '';
  if (user.length === 0) {
    throw new TerminalError('local_capability_dependency_error', 'capability probe returned an empty user');
  }

  const capabilities = emptyCapabilities();
  for (const name of TARGET_CAPABILITY_NAMES) {
    const available = fields.get(`cap.${name}.available`) === '1';
    const version = available ? (fields.get(`cap.${name}.version`) ?? null) : null;
    capabilities[name] = Object.freeze({ available, version });
  }

  const rootProviders = emptyRootProviders();
  for (const name of ROOT_PROVIDER_NAMES) {
    rootProviders[name] = fields.get(`root.${name}`) === '1';
  }

  return Object.freeze({
    uid,
    user,
    capabilities: Object.freeze(capabilities),
    rootProviders: Object.freeze(rootProviders),
  });
}

function cacheView(base, status, ttlMs) {
  return Object.freeze({
    ...base,
    cache: Object.freeze({ status, ttl_ms: ttlMs }),
  });
}

function safeDuration(now, startedAt) {
  const ended = Number(now());
  return Number.isFinite(ended) && Number.isFinite(startedAt) ? Math.max(0, ended - startedAt) : 0;
}

export function createCapabilityInventory({
  ttlMs,
  env = process.env,
  resolveTargetImpl = resolveTarget,
  remoteExecImpl = remoteExec,
  now = Date.now,
  telemetry = terminalTelemetry,
} = {}) {
  const configuredTtl = ttlMs ?? readCapabilityCacheConfig(env).ttlMs;
  if (!Number.isInteger(configuredTtl) || configuredTtl < 1 || configuredTtl > 3_600_000) {
    throw new TypeError('ttlMs must be an integer between 1 and 3600000');
  }
  if (typeof resolveTargetImpl !== 'function') throw new TypeError('resolveTargetImpl must be a function');
  if (typeof remoteExecImpl !== 'function') throw new TypeError('remoteExecImpl must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  const cache = new Map();
  const pending = new Map();

  async function collect(target, { refresh }) {
    const resolved = await resolveTargetImpl(target);
    const identity = publicIdentity(target, resolved);
    if (identity.user.length === 0) {
      throw new TerminalError('target_resolution_error', `OpenSSH target ${target} did not resolve a user`);
    }
    const fingerprint = identityFingerprint(target, identity);
    const currentMs = Number(now());
    if (!Number.isFinite(currentMs)) throw new TypeError('now() must return a finite millisecond timestamp');
    const existing = cache.get(target);

    if (!refresh && existing && existing.fingerprint === fingerprint && currentMs < existing.expiresAtMs) {
      telemetry?.incrementCounter?.('capability_cache_hit');
      return cacheView(existing.base, 'hit', configuredTtl);
    }

    if (refresh) telemetry?.incrementCounter?.('capability_cache_refresh');
    else telemetry?.incrementCounter?.('capability_cache_miss');

    const startedAt = Number(now());
    let executed;
    try {
      executed = await remoteExecImpl({
        target,
        command: CAPABILITY_PROBE_COMMAND,
        env: { LC_ALL: 'C' },
        timeout_ms: 15_000,
        max_output_bytes: 65_536,
      });
    } finally {
      telemetry?.recordTiming?.('capability_probe', safeDuration(now, startedAt));
    }

    if (executed.timed_out) {
      throw new TerminalError('timeout', 'target capability probe timed out', {
        retryable: true,
        details: { target },
      });
    }
    if (executed.exit_code !== 0) {
      throw new TerminalError(
        'remote_command_nonzero_exit',
        `target capability probe exited with status ${executed.exit_code}`,
        { details: { target, exit_code: executed.exit_code, stderr: executed.stderr ?? '' } },
      );
    }
    if (executed.truncated) {
      throw new TerminalError(
        'local_capability_dependency_error',
        'target capability probe exceeded its bounded output contract',
        { details: { target } },
      );
    }

    const parsed = parseProbe(executed.stdout);
    const collectedMs = Number(now());
    const expiresAtMs = collectedMs + configuredTtl;
    const base = Object.freeze({
      target,
      identity,
      user: parsed.user,
      uid: parsed.uid,
      capabilities: parsed.capabilities,
      root_providers: parsed.rootProviders,
      collected_at: new Date(collectedMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
    });
    cache.set(target, { fingerprint, base, expiresAtMs });
    return cacheView(base, refresh ? 'refresh' : 'miss', configuredTtl);
  }

  async function get(targetInput, { refresh = false } = {}) {
    const target = validateTarget(targetInput);
    if (typeof refresh !== 'boolean') {
      throw new TerminalError('validation_error', 'refresh must be a boolean');
    }
    let operation = pending.get(target);
    if (!operation) {
      operation = collect(target, { refresh });
      pending.set(target, operation);
      operation.finally(() => {
        if (pending.get(target) === operation) pending.delete(target);
      }).catch(() => {});
    }
    return operation;
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
    return Object.freeze({
      entries: cache.size,
      pending: pending.size,
      ttl_ms: configuredTtl,
      target_hashes: Object.freeze([...cache.keys()].sort().map((target) => (
        createHash('sha256').update(target).digest('hex').slice(0, 16)
      ))),
    });
  }

  return Object.freeze({ get, invalidate, snapshot });
}

export { parseProbe as parseCapabilityProbe };

