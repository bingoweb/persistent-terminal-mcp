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
