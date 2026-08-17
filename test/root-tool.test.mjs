import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalError } from '../src/errors.mjs';
import {
  LOCAL_TOOLS,
  ROOT_EXEC_TOOL,
  buildToolCatalog,
  callTool,
} from '../src/tool-registry.mjs';

test('remote_root_exec schema makes best-effort root acquisition explicit in name, description, and result', () => {
  assert.equal(ROOT_EXEC_TOOL.name, 'remote_root_exec');
  assert.match(ROOT_EXEC_TOOL.description, /privileged/i);
  assert.match(ROOT_EXEC_TOOL.description, /best-effort/i);
  assert.match(ROOT_EXEC_TOOL.description, /docker/i);
  assert.match(ROOT_EXEC_TOOL.description, /password/i);

  assert.deepEqual(ROOT_EXEC_TOOL.inputSchema.required, ['target', 'command']);
  assert.equal(ROOT_EXEC_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(ROOT_EXEC_TOOL.inputSchema.properties.target, {
    type: 'string',
    minLength: 1,
    description: 'Native OpenSSH host or alias permitted by PTEXT_ROOT_TARGETS; * enables all explicitly requested configured targets.',
  });
  assert.deepEqual(ROOT_EXEC_TOOL.inputSchema.properties.command, {
    type: 'string',
    minLength: 1,
    description: 'Command to execute as UID 0 after an explicit root provider succeeds.',
  });

  const success = ROOT_EXEC_TOOL.outputSchema.oneOf[0];
  assert.deepEqual(success.properties.strategy, {
    type: 'string',
    enum: ['direct_root', 'sudo_nopasswd', 'docker_host_root', 'sudo_password', 'su_root_password'],
    description: 'Explicit privileged execution strategy used for this call.',
  });
  assert.deepEqual(success.properties.target, { type: 'string' });
  assert.ok(success.required.includes('strategy'));
  assert.ok(success.required.includes('target'));
  assert.ok(success.required.includes('exit_code'));
  assert.ok(success.required.includes('attempts'));
  assert.equal(success.additionalProperties, false);
});

test('remote_root_exec is a canonical local tool and routes only through the explicit root provider', async () => {
  assert.equal(LOCAL_TOOLS.some((tool) => tool.name === 'remote_root_exec'), true);
  assert.equal(buildToolCatalog().some((tool) => tool.name === 'remote_root_exec'), true);

  const calls = [];
  const rootResult = {
    strategy: 'docker_host_root',
    target: 'taylan',
    exit_code: 0,
    stdout: '0\n',
    stderr: '',
    duration_ms: 18,
    timed_out: false,
    truncated: false,
    attempts: [
      { strategy: 'direct_root', status: 'unavailable' },
      { strategy: 'sudo_nopasswd', status: 'unavailable' },
      { strategy: 'docker_host_root', status: 'selected' },
    ],
  };

  const result = await callTool(
    'remote_root_exec',
    { target: 'taylan', command: 'id -u' },
    {
      upstreamClient: {
        callTool: async () => { throw new Error('must not call upstream'); },
      },
      upstreamToolNames: new Set(),
      remoteExecImpl: async () => { throw new Error('ordinary remote_exec must not be used by registry routing'); },
      rootExecImpl: async (args, deps) => {
        calls.push({ args: structuredClone(args), hasUpstream: Boolean(deps?.upstreamClient) });
        return rootResult;
      },
    },
  );

  assert.deepEqual(calls, [{ args: { target: 'taylan', command: 'id -u' }, hasUpstream: true }]);
  assert.deepEqual(result.structuredContent, rootResult);
  assert.equal(result.isError, undefined);
});

test('root provider failures keep their category and audit details instead of being concealed', async () => {
  const result = await callTool(
    'remote_root_exec',
    { target: 'taylan', command: 'id -u' },
    {
      upstreamClient: { callTool: async () => { throw new Error('must not call upstream'); } },
      upstreamToolNames: new Set(),
      rootExecImpl: async () => {
        throw new TerminalError(
          'missing_remote_capability',
          'Docker is unavailable',
          {
            details: {
              strategy: 'docker_host_root',
              target: 'taylan',
            },
          },
        );
      },
    },
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    category: 'missing_remote_capability',
    message: 'Docker is unavailable',
    retryable: false,
    details: {
      strategy: 'docker_host_root',
      target: 'taylan',
    },
  });
});
