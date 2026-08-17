import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiagnostics } from '../src/diagnostics.mjs';
import { PtyUpstreamClient } from '../src/upstream-pty.mjs';

class FakeTransport {
  constructor(url) {
    this.url = url;
    this.closed = false;
  }

  async close() {
    this.closed = true;
  }
}

function clientFactory(sequence) {
  const instances = [];
  class FakeClient {
    constructor() {
      this.index = instances.length;
      this.behavior = sequence[this.index] ?? {};
      this.connectCalls = 0;
      this.listCalls = 0;
      this.toolCalls = 0;
      this.closed = false;
      instances.push(this);
    }

    async connect() {
      this.connectCalls += 1;
      if (this.behavior.connectError) throw this.behavior.connectError;
    }

    async listTools() {
      this.listCalls += 1;
      if (typeof this.behavior.listTools === 'function') return this.behavior.listTools(this.listCalls);
      if (this.behavior.listError) throw this.behavior.listError;
      return { tools: [{ name: 'upstream-tool' }] };
    }

    async callTool(request) {
      this.toolCalls += 1;
      if (this.behavior.callError) throw this.behavior.callError;
      return { structuredContent: { name: request.name } };
    }

    getServerVersion() {
      return { name: 'pty-mcp', version: this.behavior.version ?? '1.2.3' };
    }

    async close() {
      this.closed = true;
    }
  }
  return { FakeClient, instances };
}

test('reconnect uses bounded exponential backoff with jitter and caps the delay', async () => {
  const { FakeClient, instances } = clientFactory([
    { connectError: new Error('down-1') },
    { connectError: new Error('down-2') },
    { connectError: new Error('down-3') },
    {},
  ]);
  const sleeps = [];
  const diagnostics = createDiagnostics();
  const client = new PtyUpstreamClient({
    ClientImpl: FakeClient,
    TransportImpl: FakeTransport,
    diagnostics,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    randomImpl: () => 0.5,
    reconnect: {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 250,
      jitterRatio: 0.25,
    },
  });

  const listed = await client.listTools();

  assert.deepEqual(listed, { tools: [{ name: 'upstream-tool' }] });
  assert.equal(instances.length, 4);
  assert.deepEqual(sleeps, [100, 200, 250]);
  assert.deepEqual(diagnostics.snapshot().reconnect, {
    attempts: 4,
    successes: 1,
    failures: 3,
  });
});

test('reconnect writes bounded operational events through the injected logger without tool arguments', async () => {
  const { FakeClient } = clientFactory([
    { connectError: new Error('first connect failed password=do-not-log') },
    {},
  ]);
  const events = [];
  const logger = {
    info: async (event, data) => { events.push({ level: 'info', event, data }); },
    warn: async (event, data) => { events.push({ level: 'warn', event, data }); },
  };
  const client = new PtyUpstreamClient({
    ClientImpl: FakeClient,
    TransportImpl: FakeTransport,
    logger,
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  });

  await client.listTools();

  assert.deepEqual(events.map(({ level, event }) => ({ level, event })), [
    { level: 'info', event: 'upstream_reconnect_attempt' },
    { level: 'warn', event: 'upstream_reconnect_failure' },
    { level: 'info', event: 'upstream_reconnect_attempt' },
    { level: 'info', event: 'upstream_reconnect_success' },
  ]);
  assert.deepEqual(events[0].data, { attempt: 1, max_attempts: 2 });
  assert.deepEqual(events[2].data, { attempt: 2, max_attempts: 2 });
  assert.equal(events[1].data.attempt, 1);
  assert.equal(events[1].data.error instanceof Error, true);
  assert.equal('arguments' in events[1].data, false);
});

test('concurrent callers share one reconnect promise instead of launching a reconnect storm', async () => {
  let releaseSleep;
  const sleepGate = new Promise((resolve) => { releaseSleep = resolve; });
  const { FakeClient, instances } = clientFactory([
    { connectError: new Error('first connect fails') },
    {},
  ]);
  let sleepCalls = 0;
  const client = new PtyUpstreamClient({
    ClientImpl: FakeClient,
    TransportImpl: FakeTransport,
    sleepImpl: async () => {
      sleepCalls += 1;
      await sleepGate;
    },
    randomImpl: () => 0.5,
    reconnect: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
  });

  const one = client.listTools();
  const two = client.listTools();
  const three = client.callTool('status', {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(instances.length, 1);
  assert.equal(sleepCalls, 1);
  releaseSleep();

  const [listedOne, listedTwo, called] = await Promise.all([one, two, three]);
  assert.equal(instances.length, 2);
  assert.deepEqual(listedOne, { tools: [{ name: 'upstream-tool' }] });
  assert.deepEqual(listedTwo, listedOne);
  assert.deepEqual(called.structuredContent, { name: 'status' });
});

test('successful functional tools/list resets the next reconnect backoff to the base delay', async () => {
  const sleeps = [];
  const { FakeClient, instances } = clientFactory([
    { connectError: new Error('initial down') },
    {
      listTools(call) {
        if (call === 1) return { tools: [] };
        throw new Error('connection dropped after prior success');
      },
    },
    { connectError: new Error('down again') },
    {},
  ]);
  const client = new PtyUpstreamClient({
    ClientImpl: FakeClient,
    TransportImpl: FakeTransport,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    randomImpl: () => 0.5,
    reconnect: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 800, jitterRatio: 0 },
  });

  assert.deepEqual(await client.listTools(), { tools: [] });
  assert.deepEqual(await client.listTools(), { tools: [{ name: 'upstream-tool' }] });

  assert.equal(instances.length, 4);
  assert.deepEqual(sleeps, [100, 100]);
});

test('reconnect gives up after the configured bound with a retryable transport error', async () => {
  const { FakeClient, instances } = clientFactory([
    { connectError: new Error('down-1') },
    { connectError: new Error('down-2') },
    { connectError: new Error('down-3') },
  ]);
  const diagnostics = createDiagnostics();
  const client = new PtyUpstreamClient({
    ClientImpl: FakeClient,
    TransportImpl: FakeTransport,
    diagnostics,
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    reconnect: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  });

  await assert.rejects(
    client.listTools(),
    (error) => error?.category === 'transport_reconnect_failure'
      && error?.retryable === true
      && /after 3 attempts/i.test(error.message),
  );
  assert.equal(instances.length, 3);
  assert.deepEqual(diagnostics.snapshot().reconnect, {
    attempts: 3,
    successes: 0,
    failures: 3,
  });
});

test('a failed arbitrary tool call reconnects for future work but is never replayed automatically', async () => {
  const { FakeClient, instances } = clientFactory([
    { callError: new Error('response transport lost') },
    {},
  ]);
  const client = new PtyUpstreamClient({
    ClientImpl: FakeClient,
    TransportImpl: FakeTransport,
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  });

  await assert.rejects(
    client.callTool('service_restart', { service: 'test.service' }),
    (error) => error?.category === 'transport_reconnect_failure'
      && /was not replayed/i.test(error.message),
  );

  assert.equal(instances.length, 2);
  assert.equal(instances[0].toolCalls, 1);
  assert.equal(instances[1].toolCalls, 0);
  assert.deepEqual(await client.callTool('status', {}), {
    structuredContent: { name: 'status' },
  });
  assert.equal(instances[1].toolCalls, 1);
});

test('definitive Session not found is safe to reconnect and retry exactly once', async () => {
  const staleError = new Error(
    'Streamable HTTP error: Error POSTing to endpoint: '
      + '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}',
  );
  const { FakeClient, instances } = clientFactory([
    { callError: staleError },
    {},
  ]);
  const diagnostics = createDiagnostics();
  const client = new PtyUpstreamClient({
    ClientImpl: FakeClient,
    TransportImpl: FakeTransport,
    diagnostics,
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  });

  const result = await client.callTool('create_ssh_session', {
    host: 'taylan',
    user: 'bingoweb',
    persistent: true,
  });

  assert.deepEqual(result, { structuredContent: { name: 'create_ssh_session' } });
  assert.equal(instances.length, 2);
  assert.equal(instances[0].toolCalls, 1);
  assert.equal(instances[1].toolCalls, 1);
  assert.equal(instances[0].closed, true);
  assert.deepEqual(diagnostics.snapshot().reconnect, {
    attempts: 2,
    successes: 2,
    failures: 0,
  });
});

