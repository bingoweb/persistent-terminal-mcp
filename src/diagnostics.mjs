const DEFAULT_COUNTER_MAX = 1_000_000_000;
const DEFAULT_FAILURE_CATEGORY_LIMIT = 32;
const SAFE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/u;

function positiveInteger(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function increment(value, max) {
  return Math.min(max, value + 1);
}

function deepFreezeSnapshot(snapshot) {
  Object.freeze(snapshot.reconnect);
  Object.freeze(snapshot.failures.by_category);
  Object.freeze(snapshot.failures);
  return Object.freeze(snapshot);
}

export function createDiagnostics({
  counterMax = DEFAULT_COUNTER_MAX,
  failureCategoryLimit = DEFAULT_FAILURE_CATEGORY_LIMIT,
} = {}) {
  const max = positiveInteger(counterMax, 'counterMax', DEFAULT_COUNTER_MAX);
  const categoryLimit = positiveInteger(
    failureCategoryLimit,
    'failureCategoryLimit',
    DEFAULT_FAILURE_CATEGORY_LIMIT,
  );

  let reconnectAttempts = 0;
  let reconnectSuccesses = 0;
  let reconnectFailures = 0;
  let failureTotal = 0;
  let categories = new Map();
  let otherFailures = 0;

  function recordReconnectAttempt() {
    reconnectAttempts = increment(reconnectAttempts, max);
  }

  function recordReconnectSuccess() {
    reconnectSuccesses = increment(reconnectSuccesses, max);
  }

  function recordReconnectFailure() {
    reconnectFailures = increment(reconnectFailures, max);
  }

  function recordFailure(category) {
    failureTotal = increment(failureTotal, max);

    if (typeof category !== 'string' || !SAFE_CATEGORY.test(category)) {
      otherFailures = increment(otherFailures, max);
      return;
    }

    if (!categories.has(category) && categories.size >= categoryLimit) {
      otherFailures = increment(otherFailures, max);
      return;
    }

    categories.set(category, increment(categories.get(category) ?? 0, max));
  }

  function snapshot() {
    const byCategory = {};
    for (const [category, count] of categories) byCategory[category] = count;
    if (otherFailures > 0) byCategory.other = otherFailures;

    return deepFreezeSnapshot({
      reconnect: {
        attempts: reconnectAttempts,
        successes: reconnectSuccesses,
        failures: reconnectFailures,
      },
      failures: {
        total: failureTotal,
        by_category: byCategory,
      },
    });
  }

  function reset() {
    reconnectAttempts = 0;
    reconnectSuccesses = 0;
    reconnectFailures = 0;
    failureTotal = 0;
    categories = new Map();
    otherFailures = 0;
  }

  return Object.freeze({
    recordReconnectAttempt,
    recordReconnectSuccess,
    recordReconnectFailure,
    recordFailure,
    snapshot,
    reset,
  });
}

export const terminalDiagnostics = createDiagnostics();

