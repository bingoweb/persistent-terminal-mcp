import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildForwardSshArgs,
  createForwardDefinition,
} from '../src/forward-model.mjs';

function fixedRandom() {
  return Buffer.from('00112233445566778899aabb', 'hex');
}

test('local forward normalizes localhost bind and builds fixed ssh -L argv', () => {
  const definition = createForwardDefinition({
    name: 'web',
    target: 'taylan',
    type: 'local',
    bind_address: 'localhost',
    listen_port: 18080,
    destination_host: '127.0.0.1',
    destination_port: 8080,
  }, { randomBytesImpl: fixedRandom });

  assert.deepEqual(definition, {
    forward_id: 'fwd_00112233445566778899aabb',
    name: 'web',
    target: 'taylan',
    type: 'local',
    bind_address: '127.0.0.1',
    listen_port: 18080,
    destination_host: '127.0.0.1',
    destination_port: 8080,
  });
  assert.equal(Object.isFrozen(definition), true);
  assert.deepEqual(buildForwardSshArgs(definition), [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', '127.0.0.1:18080:127.0.0.1:8080',
    'taylan',
  ]);
});

test('remote forward defaults bind address and builds fixed ssh -R argv', () => {
  const definition = createForwardDefinition({
    target: 'box',
    type: 'remote',
    listen_port: 19090,
    destination_host: 'db.internal',
    destination_port: 5432,
  }, { randomBytesImpl: fixedRandom });

  assert.equal(definition.name, null);
  assert.equal(definition.bind_address, '127.0.0.1');
  assert.deepEqual(buildForwardSshArgs(definition).slice(-3), [
    '-R', '127.0.0.1:19090:db.internal:5432', 'box',
  ]);
});

test('dynamic forward builds -D argv and rejects destination fields', () => {
  const definition = createForwardDefinition({
    name: 'socks',
    target: 'taylan',
    type: 'dynamic',
    bind_address: '::1',
    listen_port: 1080,
  }, { randomBytesImpl: fixedRandom });

  assert.deepEqual(buildForwardSshArgs(definition).slice(-3), [
    '-D', '[::1]:1080', 'taylan',
  ]);

  assert.throws(() => createForwardDefinition({
    target: 'taylan',
    type: 'dynamic',
    listen_port: 1080,
    destination_host: '127.0.0.1',
    destination_port: 80,
  }), /must not include destination/u);
});

test('invalid forward type and invalid ports are rejected before ID generation', () => {
  let randomCalls = 0;
  const randomBytesImpl = () => {
    randomCalls += 1;
    return fixedRandom();
  };

  for (const input of [
    { target: 'taylan', type: 'invalid', listen_port: 1000 },
    { target: 'taylan', type: 'dynamic', listen_port: 0 },
    { target: 'taylan', type: 'dynamic', listen_port: 65536 },
    {
      target: 'taylan',
      type: 'local',
      listen_port: 1000,
      destination_host: '127.0.0.1',
      destination_port: -1,
    },
  ]) {
    assert.throws(() => createForwardDefinition(input, { randomBytesImpl }), /type|port/u);
  }
  assert.equal(randomCalls, 0);
});

test('duplicate non-null name is rejected against existing definitions', () => {
  const existingDefinitions = [{ forward_id: 'fwd_existing', name: 'web' }];
  assert.throws(() => createForwardDefinition({
    name: 'web',
    target: 'taylan',
    type: 'dynamic',
    listen_port: 1080,
  }, {
    existingDefinitions,
    randomBytesImpl: fixedRandom,
  }), /already exists/u);
});

test('bind and destination host normalization handles IPv4, IPv6 brackets and safe hostnames', () => {
  const definition = createForwardDefinition({
    target: 'taylan',
    type: 'local',
    bind_address: '[::1]',
    listen_port: 12000,
    destination_host: '::1',
    destination_port: 12001,
  }, { randomBytesImpl: fixedRandom });

  assert.equal(definition.bind_address, '::1');
  assert.equal(definition.destination_host, '::1');
  assert.deepEqual(buildForwardSshArgs(definition).slice(-3), [
    '-L', '[::1]:12000:[::1]:12001', 'taylan',
  ]);

  assert.throws(() => createForwardDefinition({
    target: 'taylan',
    type: 'local',
    bind_address: 'bad address',
    listen_port: 12000,
    destination_host: '127.0.0.1',
    destination_port: 12001,
  }), /bind_address/u);
});
