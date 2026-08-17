export function commandResult({
  exitCode,
  stdout = '',
  stderr = '',
  durationMs = 0,
  timedOut = false,
  truncated = false,
}) {
  return {
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: durationMs,
    timed_out: Boolean(timedOut),
    truncated: Boolean(truncated),
  };
}
