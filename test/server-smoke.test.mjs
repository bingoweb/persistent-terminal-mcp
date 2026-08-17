import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.mjs';

test('MCP initialize/list/call exposes upstream tools and remote_exec through one server', async (t) => {
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

  const server = createServer({ upstreamClient, remoteExecImpl });
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
  assert(listed.tools.some((tool) => tool.name === 'prepare_secret'));

  const local = await client.callTool({
    name: 'remote_exec',
    arguments: { target: 'taylan', command: 'printf ok' },
  });
  assert.equal(local.structuredContent.stdout, 'ok');

  const upstream = await client.callTool({
    name: 'create_ssh_session',
    arguments: { host: 'taylan', user: 'bingoweb' },
  });
  assert.equal(upstream.content[0].text, 'forwarded:create_ssh_session');
  assert.deepEqual(upstreamCalls, [{
    name: 'create_ssh_session',
    args: { host: 'taylan', user: 'bingoweb' },
  }]);
});
