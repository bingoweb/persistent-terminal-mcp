const DEFAULT_COUNTER_MAX = 1_000_000_000;

export const TELEMETRY_TIMINGS = Object.freeze([
  'ssh_master_acquire',
  'ssh_handshake',
  'remote_execution',
  'capability_probe',
  'filesystem_helper',
  'root_provider',
  'transfer_runtime',
]);

export const TELEMETRY_COUNTERS = Object.freeze([
  'multiplex_hit',
  'multiplex_miss',
  'multiplex_fallback',
  'multiplex_stale_recovered',
  'capability_cache_hit',
  'capability_cache_miss',
  'capability_cache_refresh',
]);

const TIMING_SET = new Set(TELEMETRY_TIMINGS);
const COUNTER_SET = new Set(TELEMETRY_COUNTERS);
const BUCKETS = Object.freeze([
  Object.freeze({ name: 'le_10_ms', maximum: 10 }),
  Object.freeze({ name: 'le_50_ms', maximum: 50 }),
  Object.freeze({ name: 'le_100_ms', maximum: 100 }),
  Object.freeze({ name: 'le_500_ms', maximum: 500 }),
  Object.freeze({ name: 'le_1000_ms', maximum: 1_000 }),
  Object.freeze({ name: 'gt_1000_ms', maximum: Number.POSITIVE_INFINITY }),
]);

function positiveInteger(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function boundedIncrement(value, maximum) {
  return Math.min(maximum, value + 1);
}

function emptyTiming() {
  return {
    count: 0,
    totalMs: 0,
    minMs: null,
    maxMs: null,
    buckets: Object.fromEntries(BUCKETS.map(({ name }) => [name, 0])),
  };
}

function freezeTimingSnapshot(metric) {
  const buckets = Object.freeze({ ...metric.buckets });
  const average = metric.count === 0 ? 0 : Number((metric.totalMs / metric.count).toFixed(3));
  return Object.freeze({
    count: metric.count,
    total_ms: metric.totalMs,
    min_ms: metric.minMs,
    max_ms: metric.maxMs,
    average_ms: average,
    buckets,
  });
}

export function createTelemetry({ counterMax = DEFAULT_COUNTER_MAX } = {}) {
  const maximum = positiveInteger(counterMax, 'counterMax', DEFAULT_COUNTER_MAX);
  let timings = new Map(TELEMETRY_TIMINGS.map((name) => [name, emptyTiming()]));
  let counters = new Map(TELEMETRY_COUNTERS.map((name) => [name, 0]));

  function recordTiming(name, durationMs) {
    if (!TIMING_SET.has(name)) throw new TypeError(`Unknown telemetry timing: ${name}`);
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new TypeError('telemetry duration must be a finite non-negative number');
    }

    const metric = timings.get(name);
    metric.count = boundedIncrement(metric.count, maximum);
    metric.totalMs = Math.min(Number.MAX_SAFE_INTEGER, metric.totalMs + durationMs);
    metric.minMs = metric.minMs === null ? durationMs : Math.min(metric.minMs, durationMs);
    metric.maxMs = metric.maxMs === null ? durationMs : Math.max(metric.maxMs, durationMs);

    for (const bucket of BUCKETS) {
      if (durationMs <= bucket.maximum) {
        metric.buckets[bucket.name] = boundedIncrement(metric.buckets[bucket.name], maximum);
        break;
      }
    }
  }

  function incrementCounter(name) {
    if (!COUNTER_SET.has(name)) throw new TypeError(`Unknown telemetry counter: ${name}`);
    counters.set(name, boundedIncrement(counters.get(name), maximum));
  }

  function snapshot() {
    const timingSnapshot = {};
    for (const name of TELEMETRY_TIMINGS) {
      timingSnapshot[name] = freezeTimingSnapshot(timings.get(name));
    }
    const counterSnapshot = Object.freeze(Object.fromEntries(
      TELEMETRY_COUNTERS.map((name) => [name, counters.get(name)]),
    ));
    return Object.freeze({
      timings: Object.freeze(timingSnapshot),
      counters: counterSnapshot,
    });
  }

  function reset() {
    timings = new Map(TELEMETRY_TIMINGS.map((name) => [name, emptyTiming()]));
    counters = new Map(TELEMETRY_COUNTERS.map((name) => [name, 0]));
  }

  return Object.freeze({ recordTiming, incrementCounter, snapshot, reset });
}

export const terminalTelemetry = createTelemetry();

