import assert from 'node:assert/strict';
import test from 'node:test';

import { ADMIN_TOOLS, ADMIN_TOOL_NAMES, callAdminTool } from '../src/admin-tools.mjs';
import { LOCAL_TOOLS, buildToolCatalog, callTool } from '../src/tool-registry.mjs';

function committedResult() {
  return {
    transaction_id: 'tx_1', target: 'test-host', state: 'committed',
    precheck: { configured: false, passed: true, exit_code: null },
    mutation: { type: 'remote_write', path: '/tmp/demo', before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) },
    health: { passed: true, checks: [{ type: 'command', passed: true, exit_code: 0, stdout_regex_matched: null }] },
    rollback: { attempted: false, succeeded: false, verified: false, failure: null },
  };
}

test('admin_transaction publishes one closed bounded canonical schema without generic workflow primitives', () => {
  assert.deepEqual(ADMIN_TOOLS.map((tool) => tool.name), ['admin_transaction']);
  assert.equal(ADMIN_TOOL_NAMES.has('admin_transaction'), true);
  assert.equal(LOCAL_TOOLS.some((tool) => tool.name === 'admin_transaction'), true);
  assert.equal(buildToolCatalog({ upstreamTools: [] }).some((tool) => tool.name === 'admin_transaction'), true);
  const tool = ADMIN_TOOLS[0];
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['target', 'mutation', 'health_checks']);
  assert.equal(tool.inputSchema.properties.health_checks.maxItems, 8);
  assert.equal(tool.inputSchema.properties.health_checks.minItems, 1);
  assert.equal(tool.inputSchema.properties.rollback_on_failure.default, true);
  const serialized = JSON.stringify(tool.inputSchema);
  for (const forbidden of ['loop', 'steps', 'script', 'parallel', 'dag', 'shell_mutation']) {
    assert.equal(serialized.includes(`"${forbidden}"`), false);
  }
});

test('admin tool handler delegates exactly once to the injected transaction engine', async () => {
  const calls = [];
  const request = {
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo', text: 'x' },
    health_checks: [{ type: 'command', command: 'true' }],
  };
  const response = await callAdminTool('admin_transaction', request, {
    transactionEngine: { execute: async (args) => { calls.push(structuredClone(args)); return committedResult(); } },
  });
  assert.deepEqual(calls, [request]);
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, committedResult());
});

test('registry routes admin_transaction locally instead of forwarding upstream', async () => {
  const calls = [];
  const response = await callTool('admin_transaction', {
    target: 'test-host',
    mutation: { type: 'remote_write', path: '/tmp/demo', text: 'x' },
    health_checks: [{ type: 'command', command: 'true' }],
  }, {
    upstreamClient: { callTool: async () => { throw new Error('must not call upstream'); } },
    upstreamToolNames: new Set(),
    adminToolCallImpl: async (name, args) => {
      calls.push({ name, args });
      return { content: [], structuredContent: committedResult() };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'admin_transaction');
  assert.equal(response.structuredContent.state, 'committed');
});

