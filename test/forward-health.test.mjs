import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  FORWARD_TOOLS,
  callForwardTool,
  checkForwardHealth,
  checkRemoteListener,
  probeLocalTcp,
} from '../src/forward-tools.mjs';
import { buildToolCatalog, callTool } from '../src/tool-registry.mjs';

const PROCESS_IDENTITY = {
  started_at: 'Mon Aug 17 08:00:00 2026',
  identity: 'identity-a',
};

const LOCAL_RECORD = {
  forward_id: 'fwd_local',
  name: 'web',
  target: 'taylan',
  type: 'local',
  bind_address: '127.0.0.1',
  listen_port: 18080,
  destination_host: '127.0.0.1',
  destination_port: 8080,
  pid: 4242,
  process_started_at: PROCESS_IDENTITY.started_at,
  process_identity: PROCESS_IDENTITY.identity,
  created_at: '2026-08-17T05:00:00.000Z',
};

function tool(name) {
  const found = FORWARD_TOOLS.find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

async function listenLoopback() {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

test('probeLocalTcp performs a real bounded TCP connect probe', async (t) => {
  const server = await listenLoopback();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.equal(await probeLocalTcp('127.0.0.1', address.port, { timeoutMs: 500 }), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probeLocalTcp('127.0.0.1', address.port, { timeoutMs: 100 }), false);
});

test('dynamic health requires matching process identity plus local SOCKS listener presence', async () => {
  const calls = [];
  const record = {
    ...LOCAL_RECORD,
    forward_id: 'fwd_socks',
    name: 'socks',
    type: 'dynamic',
    listen_port: 1080,
  };
  delete record.destination_host;
  delete record.destination_port;

  const health = await checkForwardHealth(record, {
    readProcessIdentityImpl: async () => PROCESS_IDENTITY,
    probeLocalTcpImpl: async (host, port) => {
      calls.push({ host, port });
      return true;
    },
  });

  assert.deepEqual(calls, [{ host: '127.0.0.1', port: 1080 }]);
  assert.deepEqual(health, {
    state: 'healthy',
    process_identity_ok: true,
    listener_ok: true,
  });
});

test('remote listener health uses fixed ss command through remote_exec and checks bind port', async () => {
  const calls = [];
  const healthy = await checkRemoteListener('taylan', '127.0.0.1', 19090, {
    remoteExecImpl: async (request) => {
      calls.push(request);
      return {
        exit_code: 0,
        stdout: 'LISTEN 0 128 127.0.0.1:19090 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:22 0.0.0.0:*\n',
        stderr: '',
        duration_ms: 4,
        timed_out: false,
        truncated: false,
      };
    },
  });

  assert.equal(healthy, true);
  assert.deepEqual(calls, [{
    target: 'taylan',
    command: 'ss -ltnH',
    timeout_ms: 5000,
    max_output_bytes: 262144,
  }]);
});

test('process identity mismatch classifies forward as stale without probing any listener', async () => {
  let probeCalled = false;
  const health = await checkForwardHealth(LOCAL_RECORD, {
    readProcessIdentityImpl: async () => ({
      started_at: 'Mon Aug 17 09:00:00 2026',
      identity: 'replacement',
    }),
    probeLocalTcpImpl: async () => {
      probeCalled = true;
      return true;
    },
  });

  assert.equal(probeCalled, false);
  assert.deepEqual(health, {
    state: 'stale',
    process_identity_ok: false,
    listener_ok: false,
  });
});

test('forward_create reuses the same healthy named forward instead of spawning a duplicate', async () => {
  let createCalls = 0;
  const manager = {
    async listRecords() { return [structuredClone(LOCAL_RECORD)]; },
    async findRecord(identifier) {
      return identifier === 'web' || identifier === 'fwd_local' ? structuredClone(LOCAL_RECORD) : null;
    },
    async create() {
      createCalls += 1;
      throw new Error('must not create duplicate');
    },
  };

  const result = await callForwardTool('forward_create', {
    name: 'web',
    target: 'taylan',
    type: 'local',
    bind_address: '127.0.0.1',
    listen_port: 18080,
    destination_host: '127.0.0.1',
    destination_port: 8080,
  }, {
    forwardManager: manager,
    checkForwardHealthImpl: async () => ({
      state: 'healthy',
      process_identity_ok: true,
      listener_ok: true,
    }),
  });

  assert.equal(createCalls, 0);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.forward_id, 'fwd_local');
  assert.equal(result.structuredContent.reused, true);
  assert.equal(result.structuredContent.health.state, 'healthy');
  assert.equal('process_identity' in result.structuredContent, false);
});

test('forward tools publish canonical schemas and unified registry routes them locally', async () => {
  for (const name of ['forward_create', 'forward_list', 'forward_status', 'forward_close']) tool(name);
  const catalog = buildToolCatalog({ upstreamTools: [] });
  for (const name of ['forward_create', 'forward_list', 'forward_status', 'forward_close']) {
    assert(catalog.some((item) => item.name === name), `catalog missing ${name}`);
  }

  const expected = { structuredContent: { sentinel: true }, content: [] };
  const calls = [];
  const returned = await callTool('forward_status', { forward_id: 'fwd_local' }, {
    upstreamClient: { callTool: async () => { throw new Error('must not forward upstream'); } },
    upstreamToolNames: new Set(),
    forwardToolCallImpl: async (name, args) => {
      calls.push({ name, args });
      return expected;
    },
  });
  assert.strictEqual(returned, expected);
  assert.deepEqual(calls, [{ name: 'forward_status', args: { forward_id: 'fwd_local' } }]);
});
