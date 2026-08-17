import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOTE_EXEC_TOOL,
  buildToolCatalog,
  callTool,
} from '../src/tool-registry.mjs';

const SECRET_TOOL_NAMES = [
  'prepare_secret',
  'send_secret',
  'get_credential_bundle',
  'inject_secret',
];

test('catalog contains upstream tools plus remote_exec without rewriting upstream schemas', async () => {
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
  for (const name of SECRET_TOOL_NAMES) {
    const original = upstreamTools.find((tool) => tool.name === name);
    const published = catalog.find((tool) => tool.name === name);
    assert.deepEqual(published, original);
  }
  assert.deepEqual(catalog.find((tool) => tool.name === 'remote_exec'), REMOTE_EXEC_TOOL);
});

test('catalog rejects an upstream/local tool name collision', () => {
  assert.throws(
    () => buildToolCatalog({ upstreamTools: [{ name: 'remote_exec', inputSchema: { type: 'object' } }] }),
    /collision.*remote_exec/i,
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
