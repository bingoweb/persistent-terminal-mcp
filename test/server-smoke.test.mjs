import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.mjs';
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

  const ensureTool = listed.tools.find((tool) => tool.name === 'ensure_session');
  assert.deepEqual(ensureTool.inputSchema.required, ['name', 'target']);
  assert.equal(ensureTool.inputSchema.properties.persistent.default, true);

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
