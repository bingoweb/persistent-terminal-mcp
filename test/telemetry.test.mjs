import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TELEMETRY_COUNTERS,
  TELEMETRY_TIMINGS,
  createTelemetry,
} from '../src/telemetry.mjs';

test('telemetry exposes a fixed payload-free metric vocabulary', () => {
  assert.deepEqual([...TELEMETRY_TIMINGS], [
    'ssh_master_acquire',
    'ssh_handshake',
    'remote_execution',
    'capability_probe',
    'filesystem_helper',
    'root_provider',
    'transfer_runtime',
  ]);
  assert.deepEqual([...TELEMETRY_COUNTERS], [
    'multiplex_hit',
    'multiplex_miss',
    'multiplex_fallback',
    'multiplex_stale_recovered',
    'capability_cache_hit',
    'capability_cache_miss',
    'capability_cache_refresh',
  ]);
});

test('telemetry records bounded timing aggregates and fixed latency buckets', () => {
  const telemetry = createTelemetry();
  for (const duration of [3, 25, 80, 250, 750, 1_500]) {
    telemetry.recordTiming('remote_execution', duration);
  }

  const metric = telemetry.snapshot().timings.remote_execution;
  assert.deepEqual(metric, {
    count: 6,
    total_ms: 2608,
    min_ms: 3,
    max_ms: 1500,
    average_ms: 434.667,
    buckets: {
      le_10_ms: 1,
      le_50_ms: 1,
      le_100_ms: 1,
      le_500_ms: 1,
      le_1000_ms: 1,
      gt_1000_ms: 1,
    },
  });
});

test('telemetry counters saturate at their configured bound', () => {
  const telemetry = createTelemetry({ counterMax: 2 });
  telemetry.incrementCounter('multiplex_hit');
  telemetry.incrementCounter('multiplex_hit');
  telemetry.incrementCounter('multiplex_hit');

  assert.equal(telemetry.snapshot().counters.multiplex_hit, 2);
});

test('telemetry rejects unknown metric names and invalid durations', () => {
  const telemetry = createTelemetry();
  assert.throws(() => telemetry.recordTiming('command_text', 5), /unknown telemetry timing/i);
  assert.throws(() => telemetry.incrementCounter('password_seen'), /unknown telemetry counter/i);
  assert.throws(() => telemetry.recordTiming('remote_execution', -1), /duration/i);
  assert.throws(() => telemetry.recordTiming('remote_execution', Number.NaN), /duration/i);
});

test('telemetry snapshots are deeply immutable and do not retain extra payload arguments', () => {
  const telemetry = createTelemetry();
  telemetry.recordTiming('ssh_master_acquire', 12, {
    command: 'TEST_COMMAND_MUST_NOT_APPEAR',
    password: 'TEST_PASSWORD_MUST_NOT_APPEAR',
  });
  telemetry.incrementCounter('multiplex_miss', {
    target: 'TEST_TARGET_MUST_NOT_APPEAR',
  });

  const snapshot = telemetry.snapshot();
  const serialized = JSON.stringify(snapshot);
  for (const sentinel of [
    'TEST_COMMAND_MUST_NOT_APPEAR',
    'TEST_PASSWORD_MUST_NOT_APPEAR',
    'TEST_TARGET_MUST_NOT_APPEAR',
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.timings), true);
  assert.equal(Object.isFrozen(snapshot.timings.ssh_master_acquire), true);
  assert.equal(Object.isFrozen(snapshot.timings.ssh_master_acquire.buckets), true);
  assert.equal(Object.isFrozen(snapshot.counters), true);
});

test('telemetry reset preserves the public shape and clears all aggregates', () => {
  const telemetry = createTelemetry();
  telemetry.recordTiming('capability_probe', 20);
  telemetry.incrementCounter('capability_cache_miss');
  telemetry.reset();

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.timings.capability_probe.count, 0);
  assert.equal(snapshot.timings.capability_probe.total_ms, 0);
  assert.equal(snapshot.timings.capability_probe.min_ms, null);
  assert.equal(snapshot.timings.capability_probe.max_ms, null);
  assert.equal(snapshot.timings.capability_probe.average_ms, 0);
  assert.equal(snapshot.counters.capability_cache_miss, 0);
});

