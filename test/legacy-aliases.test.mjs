import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_ALIAS_SPECS,
  buildLegacyAliasTools,
  resolveLegacyAliasCall,
} from '../src/legacy-aliases.mjs';
import {
  buildToolCatalog,
  callTool,
} from '../src/tool-registry.mjs';

const READ_OUTPUT_TOOL = {
  name: 'read_output',
  description: 'Read terminal output.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      since_cursor: { type: 'integer' },
      max_bytes: { type: 'integer' },
    },
    required: ['session_id'],
  },
  outputSchema: {
    type: 'object',
    properties: { cursor: { type: 'integer' } },
  },
};

test('legacy alias map contains only the legacy names proven by project history', () => {
  assert.deepEqual(
    LEGACY_ALIAS_SPECS.map(({ name, target }) => ({ name, target })),
    [
      { name: 'ssh_exec', target: 'remote_exec' },
      { name: 'ssh_ensure_session', target: 'ensure_session' },
      { name: 'ssh_read_session', target: 'read_output' },
    ],
  );
});

test('legacy alias tools inherit canonical schemas and clearly advertise deprecation', () => {
  const canonicalTools = [
    {
      name: 'remote_exec',
      description: 'Execute remotely.',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { exit_code: { type: 'integer' } } },
    },
    {
      name: 'ensure_session',
      description: 'Ensure session.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { reused: { type: 'boolean' } } },
    },
    READ_OUTPUT_TOOL,
  ];

  const aliases = buildLegacyAliasTools(canonicalTools);

  assert.deepEqual(aliases.map((tool) => tool.name), [
    'ssh_exec',
    'ssh_ensure_session',
    'ssh_read_session',
  ]);

  for (const alias of aliases) {
    const spec = LEGACY_ALIAS_SPECS.find((item) => item.name === alias.name);
    const canonical = canonicalTools.find((item) => item.name === spec.target);
    assert.match(alias.description, /DEPRECATED/);
    assert.match(alias.description, new RegExp(spec.target));
    assert.deepEqual(alias.inputSchema, canonical.inputSchema);
    assert.deepEqual(alias.outputSchema, canonical.outputSchema);
  }
});

test('legacy alias resolution is metadata-only and preserves arguments unchanged', () => {
  const args = {
    session_id: 'local-main',
    since_cursor: 42,
    max_bytes: 8192,
  };

  const resolved = resolveLegacyAliasCall('ssh_read_session', args);

  assert.equal(resolved.target, 'read_output');
  assert.strictEqual(resolved.args, args);
});

test('tool catalog publishes legacy aliases alongside canonical and upstream tools', () => {
  const catalog = buildToolCatalog({ upstreamTools: [READ_OUTPUT_TOOL] });

  for (const name of ['ssh_exec', 'ssh_ensure_session', 'ssh_read_session']) {
    const tool = catalog.find((item) => item.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.match(tool.description, /DEPRECATED/);
  }
});

test('ssh_exec and ssh_ensure_session aliases route through the same canonical handlers', async () => {
  const remoteCalls = [];
  const sessionCalls = [];
  const remoteResult = {
    exit_code: 0,
    stdout: 'ok',
    stderr: '',
    duration_ms: 1,
    timed_out: false,
    truncated: false,
  };
  const sessionResult = {
    content: [{ type: 'text', text: '{"session_id":"local-main"}' }],
    structuredContent: { session_id: 'local-main' },
  };
  const deps = {
    upstreamClient: { callTool: async () => { throw new Error('must not call upstream'); } },
    upstreamToolNames: new Set(['read_output']),
    remoteExecImpl: async (args) => {
      remoteCalls.push(args);
      return remoteResult;
    },
    sessionToolCallImpl: async (name, args) => {
      sessionCalls.push({ name, args });
      return sessionResult;
    },
  };
  const execArgs = { target: 'test-host', command: 'true' };
  const sessionArgs = { name: 'main', target: 'test-host' };

  const canonicalExec = await callTool('remote_exec', execArgs, deps);
  const aliasExec = await callTool('ssh_exec', execArgs, deps);
  const canonicalSession = await callTool('ensure_session', sessionArgs, deps);
  const aliasSession = await callTool('ssh_ensure_session', sessionArgs, deps);

  assert.deepEqual(aliasExec, canonicalExec);
  assert.strictEqual(aliasSession, canonicalSession);
  assert.deepEqual(remoteCalls, [execArgs, execArgs]);
  assert.deepEqual(sessionCalls, [
    { name: 'ensure_session', args: sessionArgs },
    { name: 'ensure_session', args: sessionArgs },
  ]);
});

test('ssh_read_session forwards to upstream read_output with identical arguments and result', async () => {
  const calls = [];
  const upstreamResult = {
    content: [{ type: 'text', text: 'terminal output' }],
    _meta: { untouched: true },
  };
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return upstreamResult;
    },
  };
  const deps = {
    upstreamClient,
    upstreamToolNames: new Set(['read_output']),
    remoteExecImpl: async () => { throw new Error('must not call remote_exec'); },
    sessionToolCallImpl: async () => { throw new Error('must not call session layer'); },
  };
  const args = { session_id: 'local-main', since_cursor: 10, max_bytes: 4096 };

  const canonical = await callTool('read_output', args, deps);
  const alias = await callTool('ssh_read_session', args, deps);

  assert.strictEqual(canonical, upstreamResult);
  assert.strictEqual(alias, upstreamResult);
  assert.deepEqual(calls, [
    { name: 'read_output', args },
    { name: 'read_output', args },
  ]);
});
