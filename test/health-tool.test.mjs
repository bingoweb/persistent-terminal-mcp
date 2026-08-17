import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiagnostics } from '../src/diagnostics.mjs';
import {
  TERMINAL_HEALTH_TOOL,
  callTerminalHealthTool,
  getTerminalHealth,
} from '../src/health-tool.mjs';
import { LOCAL_TOOLS, callTool } from '../src/tool-registry.mjs';
import { VERSION } from '../src/version.mjs';

function toolJson(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

test('terminal_health publishes a closed non-secret diagnostic schema and is canonical', () => {
  assert.equal(TERMINAL_HEALTH_TOOL.name, 'terminal_health');
  assert.match(TERMINAL_HEALTH_TOOL.description, /health/i);
  assert.equal(TERMINAL_HEALTH_TOOL.inputSchema.additionalProperties, false);
  assert.equal(TERMINAL_HEALTH_TOOL.outputSchema.oneOf[0].additionalProperties, false);
  assert.deepEqual(TERMINAL_HEALTH_TOOL.inputSchema.properties.targets, {
    type: 'array',
    maxItems: 10,
    items: { type: 'string', minLength: 1 },
    default: [],
  });
  assert.equal(LOCAL_TOOLS.some((tool) => tool.name === 'terminal_health'), true);
});

test('terminal health default extension version follows package release metadata', async () => {
  const result = await getTerminalHealth({}, {
    diagnostics: createDiagnostics(),
    upstreamClient: {
      async listTools() { return { tools: [] }; },
      getServerVersion() { return { name: 'pty-mcp', version: 'test' }; },
    },
    stateStore: {
      async read() { return { version: 1, sessions: {}, tasks: {}, forwards: {} }; },
    },
    fetchImpl: async () => ({ ok: true, async json() { return { ok: true }; } }),
  });

  assert.equal(result.extension.version, VERSION);
});

test('terminal health combines upstream, persisted lifecycle counts, gateway, target compatibility, and diagnostics', async () => {
  const diagnostics = createDiagnostics();
  diagnostics.recordReconnectAttempt();
  diagnostics.recordReconnectSuccess();
  diagnostics.recordFailure('timeout');

  const upstreamCalls = [];
  const upstreamClient = {
    async listTools() {
      return { tools: [{ name: 'read_output' }, { name: 'list_remote_sessions' }] };
    },
    getServerVersion() {
      return { name: 'pty-mcp', version: '2.4.0' };
    },
    async callTool(name, args) {
      upstreamCalls.push({ name, args: structuredClone(args) });
      if (name === 'get_session_state') {
        return toolJson({ is_alive: args.session_id === 'local-alive' });
      }
      if (name === 'list_remote_sessions') {
        return toolJson([
          { id: 'remote-a', is_alive: true },
          { id: 'remote-b', is_alive: true },
          { id: 'remote-dead', is_alive: false },
        ]);
      }
      throw new Error(`unexpected upstream tool ${name}`);
    },
  };
  const stateStore = {
    async read() {
      return {
        version: 1,
        sessions: {
          alpha: { local_session_id: 'local-alive', command: 'TEST_SHOULD_NOT_LEAK' },
          beta: { local_session_id: 'local-dead' },
          detached: { local_session_id: null },
        },
        tasks: {
          running: { state: 'running', command: 'TEST_TASK_SECRET' },
          queued: { state: 'queued' },
          done: { state: 'succeeded' },
        },
        forwards: {
          good: { forward_id: 'good', process_identity: 'SECRET_PROCESS_IDENTITY' },
          bad: { forward_id: 'bad' },
        },
      };
    },
  };
  const fetchCalls = [];
  const result = await getTerminalHealth(
    { targets: ['taylan'], include_remote_sessions: true },
    {
      extensionVersion: '0.1.0-test',
      diagnostics,
      upstreamClient,
      stateStore,
      forwardHealthImpl: async (record) => ({ state: record.forward_id === 'good' ? 'healthy' : 'stale' }),
      resolveTargetImpl: async () => ({ alias: 'taylan', user: 'bingoweb' }),
      remoteExecImpl: async (request) => {
        assert.equal(request.env.LC_ALL, 'C');
        assert.equal(request.command, 'command -v ai-tmux >/dev/null 2>&1 && ai-tmux --version');
        return {
          exit_code: 0,
          stdout: 'ai-tmux version 0.9.7\n',
          stderr: '',
          duration_ms: 4,
          timed_out: false,
          truncated: false,
        };
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url: String(url), options });
        return {
          ok: true,
          async json() { return { ok: true, service: 'pty-gateway' }; },
        };
      },
    },
  );

  assert.deepEqual(result.extension, { version: '0.1.0-test', healthy: true });
  assert.deepEqual(result.upstream, {
    healthy: true,
    version: { name: 'pty-mcp', version: '2.4.0' },
    tool_count: 2,
  });
  assert.deepEqual(result.gateway, {
    healthy: true,
    url: 'http://127.0.0.1:9022/healthz',
  });
  assert.deepEqual(result.counts, {
    sessions: { known: 3, active: 1 },
    tasks: { known: 3, active: 2 },
    forwards: { known: 2, active: 1 },
  });
  assert.deepEqual(result.targets, [{
    target: 'taylan',
    ai_tmux: { available: true, version: 'ai-tmux version 0.9.7', compatible: true },
    remote_sessions: 2,
  }]);
  assert.deepEqual(result.diagnostics, {
    reconnect: { attempts: 1, successes: 1, failures: 0 },
    failures: { total: 1, by_category: { timeout: 1 } },
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:9022/healthz');
  assert.ok(fetchCalls[0].options.signal instanceof AbortSignal);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['TEST_SHOULD_NOT_LEAK', 'TEST_TASK_SECRET', 'SECRET_PROCESS_IDENTITY', 'local-alive', 'remote-a']) {
    assert.equal(serialized.includes(forbidden), false, `health leaked ${forbidden}`);
  }
});

test('target and gateway failures stay diagnostic and do not make the whole health tool throw', async () => {
  const result = await getTerminalHealth(
    { targets: ['offline'], include_remote_sessions: true },
    {
      upstreamClient: {
        async listTools() { return { tools: [] }; },
        getServerVersion() { return null; },
        async callTool() { throw new Error('remote session probe unavailable'); },
      },
      stateStore: {
        async read() { return { version: 1, sessions: {}, tasks: {}, forwards: {} }; },
      },
      resolveTargetImpl: async () => ({ alias: 'offline', user: 'nobody' }),
      remoteExecImpl: async () => { throw new Error('ssh transport failed'); },
      fetchImpl: async () => { throw new Error('gateway down'); },
      forwardHealthImpl: async () => ({ state: 'stale' }),
    },
  );

  assert.equal(result.extension.healthy, true);
  assert.equal(result.upstream.healthy, true);
  assert.equal(result.gateway.healthy, false);
  assert.deepEqual(result.targets, [{
    target: 'offline',
    ai_tmux: { available: false, version: null, compatible: false },
    remote_sessions: null,
  }]);
});

test('terminal_health routes locally through the unified registry', async () => {
  const calls = [];
  const response = await callTool(
    'terminal_health',
    { targets: [] },
    {
      upstreamClient: { callTool: async () => { throw new Error('must not forward health upstream'); } },
      upstreamToolNames: new Set(),
      healthToolCallImpl: async (args, deps) => {
        calls.push({ args: structuredClone(args), upstream: deps.upstreamClient });
        return toolJson({ extension: { version: 'test', healthy: true } });
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { targets: [] });
  assert.deepEqual(response.structuredContent, { extension: { version: 'test', healthy: true } });
});

test('callTerminalHealthTool normalizes unexpected failures without logging payloads', async () => {
  const response = await callTerminalHealthTool(
    {},
    {
      healthImpl: async () => { throw new Error('synthetic health failure'); },
    },
  );
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.category, 'local_capability_dependency_error');
  assert.equal(response.structuredContent.message, 'synthetic health failure');
});

