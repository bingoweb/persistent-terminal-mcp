import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createProductionRuntime, createServer } from '../src/server.mjs';
import { TerminalError } from '../src/errors.mjs';

test('MCP initialize/list/call exposes upstream tools plus canonical local tools through one server', async (t) => {
  const upstreamCalls = [];
  const upstreamClient = {
    listTools: async () => ({
      tools: [
        { name: 'create_ssh_session', description: 'persistent ssh', inputSchema: { type: 'object' } },
        { name: 'prepare_secret', description: 'secret', inputSchema: { type: 'object' } },
      ],
    }),
    callTool: async (name, args) => {
      upstreamCalls.push({ name, args });
      return { content: [{ type: 'text', text: `forwarded:${name}` }] };
    },
  };
  const remoteExecImpl = async () => ({
    exit_code: 0,
    stdout: 'ok',
    stderr: '',
    duration_ms: 2,
    timed_out: false,
    truncated: false,
  });
  const sessionCalls = [];
  const sessionToolCallImpl = async (name, args) => {
    sessionCalls.push({ name, args });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        session_id: 'local-main',
        remote_session_id: 'remote-main',
        reused: true,
        recovered: false,
      }) }],
      structuredContent: {
        session_id: 'local-main',
        remote_session_id: 'remote-main',
        reused: true,
        recovered: false,
      },
    };
  };

  const server = createServer({ upstreamClient, remoteExecImpl, sessionToolCallImpl });
  const client = new Client({ name: 'persistent-terminal-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  t.after(async () => {
    await client.close();
    await server.close();
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert(listed.tools.some((tool) => tool.name === 'create_ssh_session'));
  assert(listed.tools.some((tool) => tool.name === 'remote_exec'));
  assert(listed.tools.some((tool) => tool.name === 'ensure_session'));
  assert(listed.tools.some((tool) => tool.name === 'named_session_list'));
  assert(listed.tools.some((tool) => tool.name === 'named_session_detach'));
  assert(listed.tools.some((tool) => tool.name === 'named_session_close'));
  assert(listed.tools.some((tool) => tool.name === 'prepare_secret'));
  assert(listed.tools.some((tool) => tool.name === 'target_capabilities'));
  assert(listed.tools.some((tool) => tool.name === 'target_diagnose'));

  const ensureTool = listed.tools.find((tool) => tool.name === 'ensure_session');
  assert.deepEqual(ensureTool.inputSchema.required, ['name', 'target']);
  assert.equal(ensureTool.inputSchema.properties.persistent.default, true);
  assert.deepEqual(ensureTool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  const upstreamTool = listed.tools.find((tool) => tool.name === 'create_ssh_session');
  assert.equal(upstreamTool.annotations, undefined);

  const local = await client.callTool({
    name: 'remote_exec',
    arguments: { target: 'test-host', command: 'printf ok' },
  });
  assert.equal(local.structuredContent.stdout, 'ok');

  const session = await client.callTool({
    name: 'ensure_session',
    arguments: { name: 'main', target: 'test-host' },
  });
  assert.equal(session.structuredContent.session_id, 'local-main');
  assert.deepEqual(sessionCalls, [{
    name: 'ensure_session',
    args: { name: 'main', target: 'test-host' },
  }]);

  const upstream = await client.callTool({
    name: 'create_ssh_session',
    arguments: { host: 'test-host', user: 'tester' },
  });
  assert.equal(upstream.content[0].text, 'forwarded:create_ssh_session');
  assert.deepEqual(upstreamCalls, [{
    name: 'create_ssh_session',
    args: { host: 'test-host', user: 'tester' },
  }]);
});

test('production runtime wires the rotating diagnostic logger into the upstream client', async (t) => {
  const logger = Object.freeze({
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    close: async () => {},
  });
  let loggerOptions;
  let upstreamOptions;

  class FakeUpstreamClient {
    constructor(options) {
      upstreamOptions = options;
    }

    async listTools() {
      return { tools: [] };
    }

    async callTool() {
      throw new Error('not used');
    }
  }

  const runtime = createProductionRuntime({
    homeDir: '/tmp/persistent-terminal-release-test',
    loggerFactory(options) {
      loggerOptions = options;
      return logger;
    },
    UpstreamClientImpl: FakeUpstreamClient,
  });
  t.after(async () => runtime.server.close());

  assert.equal(
    runtime.logPath,
    '/tmp/persistent-terminal-release-test/.local/share/persistent-terminal-extended/diagnostics.jsonl',
  );
  assert.deepEqual(loggerOptions, { path: runtime.logPath });
  assert.equal(upstreamOptions.logger, logger);
});

test('production runtime creates one shared telemetry multiplex manager capability inventory and privilege engine for repeated remote work', async (t) => {
  const logger = Object.freeze({ info: async () => {}, warn: async () => {}, error: async () => {}, close: async () => {} });
  const telemetry = Object.freeze({
    recordTiming() {},
    incrementCounter() {},
    snapshot: () => ({ timings: {}, counters: {} }),
    reset() {},
  });
  const manager = Object.freeze({
    acquire: async () => ({ args: [], state: 'off' }),
    inspect: () => ({ mode: 'off', state: 'off', active: false, target_hash: null }),
    snapshot: () => ({ mode: 'off', active_masters: 0 }),
    closeIdle: async () => {},
    closeAll: async () => {},
  });
  const diagnosticCapabilities = Object.freeze(Object.fromEntries([
    'python3', 'rsync', 'sudo', 'docker', 'su', 'systemctl', 'journalctl', 'ss',
    'nvidia-smi', 'curl', 'openssl', 'dig', 'getent', 'ip', 'traceroute', 'mtr', 'ai-tmux',
  ].map((name) => [name, Object.freeze({ available: false, version: null })])));
  const inventory = Object.freeze({
    get: async () => ({
      target: 'test-host',
      identity: { hostname: '203.0.113.40', user: 'tester', port: 22, proxy_jump: null },
      user: 'tester',
      uid: 1000,
      capabilities: diagnosticCapabilities,
      root_providers: {
        direct_root: false, sudo_nopasswd: false, docker_host_root: false,
        sudo_password: false, su_root_password: false,
      },
      collected_at: '2026-08-17T09:00:00.000Z',
      expires_at: '2026-08-17T09:02:00.000Z',
      cache: { status: 'hit', ttl_ms: 120000 },
    }),
    invalidate: () => 0,
    snapshot: () => ({ entries: 1, pending: 0, ttl_ms: 120000, target_hashes: ['hidden'] }),
  });
  const privilegeCalls = [];
  const privilegeEngine = Object.freeze({
    async execute(request, deps) {
      privilegeCalls.push({ request: structuredClone(request), deps });
      return {
        strategy: 'docker_host_root', target: request.target, exit_code: 0, stdout: '0\n', stderr: '',
        duration_ms: 2, timed_out: false, truncated: false,
        attempts: [{ strategy: 'docker_host_root', status: 'selected' }],
      };
    },
    invalidate: () => 0,
    snapshot: () => ({ ttl_ms: 120000, entries: 0, providers: {} }),
  });
  const adminCalls = [];
  const healthCalls = [];
  const adminEngine = Object.freeze({
    async execute(request) {
      adminCalls.push(structuredClone(request));
      return {
        transaction_id: 'tx_shared_runtime',
        target: request.target,
        state: 'committed',
        precheck: { configured: false, passed: true, exit_code: null },
        mutation: { type: 'remote_write', path: '/tmp/demo', before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) },
        health: { passed: true, checks: [] },
        rollback: { attempted: false, succeeded: false, verified: false, failure: null },
      };
    },
  });
  const factoryCalls = [];
  const runnerCalls = [];

  class FakeUpstreamClient {
    constructor() {}
    async listTools() { return { tools: [] }; }
    async callTool() { throw new Error('not used'); }
  }

  const runtime = createProductionRuntime({
    homeDir: '/tmp/ptext-shared-runtime',
    env: {},
    loggerFactory: () => logger,
    UpstreamClientImpl: FakeUpstreamClient,
    telemetryFactory: () => telemetry,
    multiplexManagerFactory(options) {
      factoryCalls.push({ type: 'multiplex', options });
      return manager;
    },
    capabilityInventoryFactory(options) {
      factoryCalls.push({ type: 'inventory', options });
      return inventory;
    },
    privilegeEngineFactory(options) {
      factoryCalls.push({ type: 'privilege', options });
      return privilegeEngine;
    },
    adminTransactionEngineFactory(options) {
      factoryCalls.push({ type: 'admin', options });
      return adminEngine;
    },
    healthImpl: async (args, deps) => {
      healthCalls.push({ args: structuredClone(args), deps });
      return {
        extension: { version: 'test', healthy: true },
        upstream: { healthy: true, version: null, tool_count: 0 },
        gateway: { healthy: true, url: 'http://127.0.0.1:9022/healthz' },
        counts: {
          sessions: { known: 0, active: 0 },
          tasks: { known: 0, active: 0 },
          forwards: { known: 0, active: 0 },
        },
        targets: [],
        diagnostics: {
          reconnect: { attempts: 0, successes: 0, failures: 0 },
          failures: { total: 0, by_category: {} },
        },
        runtime: {
          telemetry: { state: 'available', timings: {}, counters: {} },
          multiplex: { state: 'available', mode: 'off', active_masters: 0 },
          capability_cache: { state: 'available', entries: 1, pending: 0, ttl_ms: 120000 },
          privilege_cache: {
            state: 'available', ttl_ms: 120000, entries: 0,
            providers: { direct_root: 0, sudo_nopasswd: 0, docker_host_root: 0 },
          },
        },
      };
    },
    runSshCommandImpl: async (target, request, deps) => {
      runnerCalls.push({ target, request: { ...request }, deps });
      return {
        code: 0, signal: null, stdout: 'ok', stderr: '', durationMs: 1,
        timedOut: false, truncated: false, multiplexState: 'off',
      };
    },
  });
  t.after(async () => runtime.server.close());

  await runtime.remoteExecImpl({ target: 'test-host', command: 'true' });
  await runtime.remoteExecImpl({ target: 'test-host', command: 'printf ok' });
  assert.equal(factoryCalls.filter((call) => call.type === 'multiplex').length, 1);
  assert.equal(factoryCalls.filter((call) => call.type === 'inventory').length, 1);
  assert.equal(factoryCalls.filter((call) => call.type === 'privilege').length, 1);
  assert.equal(factoryCalls.filter((call) => call.type === 'admin').length, 1);
  assert.equal(factoryCalls[0].options.telemetry, telemetry);
  assert.equal(factoryCalls[1].options.telemetry, telemetry);
  assert.equal(factoryCalls[1].options.remoteExecImpl, runtime.remoteExecImpl);
  const privilegeFactoryCall = factoryCalls.find((call) => call.type === 'privilege');
  assert.equal(privilegeFactoryCall.options.telemetry, telemetry);
  assert.equal(privilegeFactoryCall.options.capabilityInventory, inventory);
  assert.equal(typeof privilegeFactoryCall.options.rootExecImpl, 'function');
  const adminFactoryCall = factoryCalls.find((call) => call.type === 'admin');
  for (const key of [
    'remoteExecImpl', 'systemdActionImpl', 'systemdStatusImpl',
    'remoteStatImpl', 'remoteReadImpl', 'remoteWriteImpl', 'remotePatchImpl',
  ]) {
    assert.equal(typeof adminFactoryCall.options[key], 'function', `missing admin dependency ${key}`);
  }
  assert.equal(adminFactoryCall.options.remoteExecImpl, runtime.remoteExecImpl);
  assert.equal(runnerCalls.length, 2);
  assert.equal(runnerCalls[0].deps.multiplexManager, manager);
  assert.equal(runnerCalls[1].deps.multiplexManager, manager);
  assert.equal(runnerCalls[0].deps.telemetry, telemetry);
  assert.equal(runtime.telemetry, telemetry);
  assert.equal(runtime.multiplexManager, manager);
  assert.equal(runtime.capabilityInventory, inventory);
  assert.equal(runtime.privilegeEngine, privilegeEngine);
  assert.equal(runtime.adminTransactionEngine, adminEngine);

  const privileged = await runtime.rootExecImpl({ target: 'test-host', command: 'id -u' });
  assert.equal(privileged.strategy, 'docker_host_root');
  assert.equal(privilegeCalls.length, 1);
  assert.equal(privilegeCalls[0].request.target, 'test-host');

  const transaction = await runtime.adminTransactionEngine.execute({
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo', text: 'x' },
    health_checks: [{ type: 'command', command: 'true' }],
  });
  assert.equal(transaction.state, 'committed');
  assert.equal(adminCalls.length, 1);

  const client = new Client({ name: 'shared-runtime-diagnostic-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => client.close());
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  const diagnostic = await client.callTool({
    name: 'target_diagnose',
    arguments: { target: 'test-host' },
  });
  assert.equal(diagnostic.structuredContent.privilege.cache.state, 'available');
  assert.equal(diagnostic.structuredContent.privilege.cache.ttl_ms, 120000);
  assert.equal(diagnostic.structuredContent.capability_cache.entries, 1);
  assert.equal(JSON.stringify(diagnostic).includes('hidden'), false);

  await client.callTool({ name: 'terminal_health', arguments: { targets: [] } });
  assert.equal(healthCalls.length, 1);
  assert.deepEqual(healthCalls[0].args, { targets: [] });
  assert.equal(healthCalls[0].deps.telemetry, telemetry);
  assert.equal(healthCalls[0].deps.multiplexManager, manager);
  assert.equal(healthCalls[0].deps.capabilityInventory, inventory);
  assert.equal(healthCalls[0].deps.privilegeEngine, privilegeEngine);
  assert.equal(healthCalls[0].deps.remoteExecImpl, runtime.remoteExecImpl);
});

test('createServer routes target tools through an injected target handler', async (t) => {
  const targetCalls = [];
  const server = createServer({
    upstreamClient: {
      listTools: async () => ({ tools: [] }),
      callTool: async () => { throw new Error('must not call upstream'); },
    },
    targetToolCallImpl: async (name, args) => {
      targetCalls.push({ name, args });
      const value = {
        target: 'test-host',
        identity: { hostname: '203.0.113.30', user: 'tester', port: 22, proxy_jump: null },
        user: 'tester',
        uid: 1000,
        capabilities: Object.fromEntries([
          'python3', 'rsync', 'sudo', 'docker', 'su', 'systemctl', 'journalctl', 'ss',
          'nvidia-smi', 'curl', 'openssl', 'dig', 'getent', 'ip', 'traceroute', 'mtr', 'ai-tmux',
        ].map((capability) => [capability, { available: false, version: null }])),
        root_providers: {
          direct_root: false,
          sudo_nopasswd: false,
          docker_host_root: false,
          sudo_password: false,
          su_root_password: false,
        },
        collected_at: '2026-08-17T08:45:00.000Z',
        expires_at: '2026-08-17T08:47:00.000Z',
        cache: { status: 'miss', ttl_ms: 120000 },
      };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    },
  });
  const client = new Client({ name: 'persistent-terminal-target-injection-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  const result = await client.callTool({ name: 'target_capabilities', arguments: { target: 'test-host' } });
  assert.equal(result.structuredContent.target, 'test-host');
  assert.deepEqual(targetCalls, [{ name: 'target_capabilities', args: { target: 'test-host' } }]);
});

test('remote_exec normalized failures satisfy the advertised MCP output schema', async (t) => {
  const server = createServer({
    upstreamClient: {
      listTools: async () => ({ tools: [] }),
      callTool: async () => { throw new Error('must not call upstream'); },
    },
    remoteExecImpl: async () => {
      throw new TerminalError('validation_error', 'bad input', { retryable: false });
    },
  });
  const client = new Client({ name: 'persistent-terminal-error-schema-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  t.after(async () => {
    await client.close();
    await server.close();
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();

  const result = await client.callTool({
    name: 'remote_exec',
    arguments: { target: 'test-host', command: 'true' },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    category: 'validation_error',
    message: 'bad input',
    retryable: false,
  });
});

test('createServer routes task tools through an injected task handler', async (t) => {
  const taskCalls = [];
  const server = createServer({
    upstreamClient: {
      listTools: async () => ({ tools: [] }),
      callTool: async () => { throw new Error('must not call upstream'); },
    },
    taskToolCallImpl: async (name, args) => {
      taskCalls.push({ name, args });
      return {
        content: [{ type: 'text', text: JSON.stringify({ tasks: [] }) }],
        structuredContent: { tasks: [] },
      };
    },
  });
  const client = new Client({ name: 'persistent-terminal-task-injection-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  t.after(async () => {
    await client.close();
    await server.close();
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();

  const result = await client.callTool({ name: 'task_list', arguments: {} });
  assert.deepEqual(result.structuredContent, { tasks: [] });
  assert.deepEqual(taskCalls, [{ name: 'task_list', args: {} }]);
});
