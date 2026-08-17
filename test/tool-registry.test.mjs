import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_TOOLS,
  REMOTE_EXEC_TOOL,
  buildToolCatalog,
  callTool,
} from '../src/tool-registry.mjs';
import { SESSION_TOOLS } from '../src/session-tools.mjs';

function withoutAnnotations(tool) {
  const { annotations: _annotations, ...rest } = tool;
  return rest;
}

const SECRET_TOOL_NAMES = [
  'prepare_secret',
  'send_secret',
  'get_credential_bundle',
  'inject_secret',
];

test('catalog contains upstream tools plus all canonical local tools without rewriting upstream schemas', async () => {
  const upstreamTools = [
    { name: 'create_ssh_session', description: 'upstream', inputSchema: { type: 'object' } },
    ...SECRET_TOOL_NAMES.map((name) => ({
      name,
      description: `${name}-description`,
      inputSchema: { type: 'object', properties: { sentinel: { type: 'string' } } },
    })),
  ];

  const catalog = buildToolCatalog({ upstreamTools });

  assert(catalog.some((tool) => tool.name === 'create_ssh_session'));
  assert(catalog.some((tool) => tool.name === 'remote_exec'));
  for (const tool of SESSION_TOOLS) {
    const published = catalog.find((item) => item.name === tool.name);
    assert.deepEqual(withoutAnnotations(published), tool);
    assert.deepEqual(published.annotations, LOCAL_TOOLS.find((item) => item.name === tool.name).annotations);
  }
  for (const name of SECRET_TOOL_NAMES) {
    const original = upstreamTools.find((tool) => tool.name === name);
    const published = catalog.find((tool) => tool.name === name);
    assert.deepEqual(published, original);
  }
  const remoteExec = catalog.find((tool) => tool.name === 'remote_exec');
  assert.deepEqual(withoutAnnotations(remoteExec), REMOTE_EXEC_TOOL);
  assert.deepEqual(remoteExec.annotations, LOCAL_TOOLS.find((tool) => tool.name === 'remote_exec').annotations);
});

test('catalog rejects an upstream/local tool name collision', () => {
  assert.throws(
    () => buildToolCatalog({ upstreamTools: [{ name: 'remote_exec', inputSchema: { type: 'object' } }] }),
    /collision.*remote_exec/i,
  );
});

test('catalog rejects an upstream collision with a canonical session tool', () => {
  assert.throws(
    () => buildToolCatalog({ upstreamTools: [{ name: 'ensure_session', inputSchema: { type: 'object' } }] }),
    /collision.*ensure_session/i,
  );
});

test('callTool routes remote_exec locally and upstream tools unchanged', async () => {
  const localResult = { exit_code: 0, stdout: 'local', stderr: '', duration_ms: 1, timed_out: false, truncated: false };
  const upstreamResult = { content: [{ type: 'text', text: 'upstream-result' }], _meta: { untouched: true } };
  const calls = [];
  const upstreamClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return upstreamResult;
    },
  };

  assert.deepEqual(
    await callTool('remote_exec', { target: 'test-host', command: 'true' }, {
      upstreamClient,
      upstreamToolNames: new Set(['create_ssh_session', ...SECRET_TOOL_NAMES]),
      remoteExecImpl: async () => localResult,
    }),
    {
      content: [{ type: 'text', text: JSON.stringify(localResult) }],
      structuredContent: localResult,
    },
  );

  const returned = await callTool('send_secret', { session_id: 'abc' }, {
    upstreamClient,
    upstreamToolNames: new Set(SECRET_TOOL_NAMES),
    remoteExecImpl: async () => { throw new Error('must not call local'); },
  });

  assert.strictEqual(returned, upstreamResult);
  assert.deepEqual(calls, [{ name: 'send_secret', args: { session_id: 'abc' } }]);
});

test('callTool routes canonical session tools to the local session layer', async () => {
  const expected = {
    content: [{ type: 'text', text: '{"session_id":"local-main"}' }],
    structuredContent: { session_id: 'local-main' },
  };
  const calls = [];

  const result = await callTool('ensure_session', { name: 'main', target: 'test-host' }, {
    upstreamClient: { callTool: async () => { throw new Error('must not forward session tool upstream'); } },
    upstreamToolNames: new Set(['create_ssh_session']),
    remoteExecImpl: async () => { throw new Error('must not call remote_exec'); },
    sessionToolCallImpl: async (name, args, deps) => {
      calls.push({ name, args, upstreamClient: deps.upstreamClient });
      return expected;
    },
  });

  assert.strictEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'ensure_session');
  assert.deepEqual(calls[0].args, { name: 'main', target: 'test-host' });
});

test('callTool rejects unknown names instead of forwarding blindly', async () => {
  await assert.rejects(
    () => callTool('not_a_tool', {}, {
      upstreamClient: { callTool: async () => { throw new Error('must not forward'); } },
      upstreamToolNames: new Set(['create_ssh_session']),
      remoteExecImpl: async () => ({}),
    }),
    /unknown tool/i,
  );
});
