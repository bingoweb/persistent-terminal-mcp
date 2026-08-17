import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readCapabilityCacheConfig,
  readSshMultiplexConfig,
} from '../src/config.mjs';

test('ssh multiplex config defaults to auto with bounded professional defaults', () => {
  assert.deepEqual(readSshMultiplexConfig({}), {
    mode: 'auto',
    controlPersistSeconds: 300,
    maxTargets: 32,
  });
});

test('ssh multiplex config accepts explicit off auto and required modes', () => {
  for (const mode of ['off', 'auto', 'required']) {
    assert.equal(readSshMultiplexConfig({ PTEXT_SSH_MULTIPLEX: mode }).mode, mode);
  }
});

test('ssh multiplex config parses bounded positive integer settings', () => {
  assert.deepEqual(readSshMultiplexConfig({
    PTEXT_SSH_MULTIPLEX: 'required',
    PTEXT_SSH_CONTROL_PERSIST_SECONDS: '900',
    PTEXT_SSH_CONTROL_MAX_TARGETS: '64',
  }), {
    mode: 'required',
    controlPersistSeconds: 900,
    maxTargets: 64,
  });

  for (const env of [
    { PTEXT_SSH_CONTROL_PERSIST_SECONDS: '0' },
    { PTEXT_SSH_CONTROL_PERSIST_SECONDS: '86401' },
    { PTEXT_SSH_CONTROL_PERSIST_SECONDS: '1.5' },
    { PTEXT_SSH_CONTROL_MAX_TARGETS: '0' },
    { PTEXT_SSH_CONTROL_MAX_TARGETS: '1025' },
    { PTEXT_SSH_CONTROL_MAX_TARGETS: 'abc' },
  ]) {
    assert.throws(() => readSshMultiplexConfig(env), /positive integer|between/i);
  }
});

test('ssh multiplex config rejects unknown modes instead of silently changing transport semantics', () => {
  assert.throws(
    () => readSshMultiplexConfig({ PTEXT_SSH_MULTIPLEX: 'best-effort' }),
    /PTEXT_SSH_MULTIPLEX.*off.*auto.*required/i,
  );
});

test('capability cache config defaults to 120 seconds and validates bounded TTL', () => {
  assert.deepEqual(readCapabilityCacheConfig({}), { ttlMs: 120_000 });
  assert.deepEqual(readCapabilityCacheConfig({
    PTEXT_CAPABILITY_CACHE_TTL_SECONDS: '45',
  }), { ttlMs: 45_000 });

  for (const value of ['0', '3601', '1.5', 'invalid']) {
    assert.throws(
      () => readCapabilityCacheConfig({ PTEXT_CAPABILITY_CACHE_TTL_SECONDS: value }),
      /PTEXT_CAPABILITY_CACHE_TTL_SECONDS.*between/i,
    );
  }
});

