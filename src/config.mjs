const SSH_MULTIPLEX_MODES = new Set(['off', 'auto', 'required']);

function readBoundedInteger(env, name, fallback, minimum, maximum) {
  const raw = env?.[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^[0-9]+$/u.test(raw.trim())) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function readSshMultiplexConfig(env = process.env) {
  const rawMode = env?.PTEXT_SSH_MULTIPLEX;
  const mode = rawMode === undefined ? 'auto' : String(rawMode).trim().toLowerCase();
  if (!SSH_MULTIPLEX_MODES.has(mode)) {
    throw new TypeError('PTEXT_SSH_MULTIPLEX must be one of: off, auto, required');
  }

  return Object.freeze({
    mode,
    controlPersistSeconds: readBoundedInteger(
      env,
      'PTEXT_SSH_CONTROL_PERSIST_SECONDS',
      300,
      1,
      86_400,
    ),
    maxTargets: readBoundedInteger(
      env,
      'PTEXT_SSH_CONTROL_MAX_TARGETS',
      32,
      1,
      1_024,
    ),
  });
}

export function readCapabilityCacheConfig(env = process.env) {
  const ttlSeconds = readBoundedInteger(
    env,
    'PTEXT_CAPABILITY_CACHE_TTL_SECONDS',
    120,
    1,
    3_600,
  );
  return Object.freeze({ ttlMs: ttlSeconds * 1_000 });
}

export function readDockerRootTargets(env = process.env) {
  const raw = env?.PTEXT_DOCKER_ROOT_TARGETS;
  if (typeof raw !== 'string' || raw.trim() === '') return new Set();

  return new Set(
    raw
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean),
  );
}

export function readRootTargets(env = process.env) {
  const explicit = env?.PTEXT_ROOT_TARGETS;
  if (typeof explicit === 'string') {
    return new Set(
      explicit
        .split(',')
        .map((target) => target.trim())
        .filter(Boolean),
    );
  }
  return readDockerRootTargets(env);
}

export function isRootTargetAllowed(target, env = process.env) {
  const allowed = readRootTargets(env);
  return allowed.has('*') || allowed.has(target);
}
