import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalError } from '../src/errors.mjs';
import {
  SYSTEMD_TOOLS,
  SYSTEMD_TOOL_NAMES,
  callSystemdTool,
} from '../src/systemd-tools.mjs';
import { LOCAL_TOOLS, buildToolCatalog, callTool } from '../src/tool-registry.mjs';

function statusResult() {
  return {
    target: 'test-host', unit: 'demo.socket', names: ['demo.socket'], description: 'Demo socket',
    load_state: 'loaded', active_state: 'active', sub_state: 'listening', unit_file_state: 'enabled',
    main_pid: 0, result: null,
  };
}

test('generic systemd read tools publish closed bounded schemas and canonical names', () => {
  assert.deepEqual(SYSTEMD_TOOLS.map((tool) => tool.name), [
    'systemd_unit_status', 'systemd_unit_list', 'systemd_unit_dependencies',
    'systemd_unit_action', 'systemd_daemon_reload',
  ]);
  for (const name of [
    'systemd_unit_status', 'systemd_unit_list', 'systemd_unit_dependencies',
    'systemd_unit_action', 'systemd_daemon_reload',
  ]) {
    assert.equal(SYSTEMD_TOOL_NAMES.has(name), true);
    assert.equal(LOCAL_TOOLS.some((tool) => tool.name === name), true);
    assert.equal(buildToolCatalog({ upstreamTools: [] }).some((tool) => tool.name === name), true);
  }
  const list = SYSTEMD_TOOLS.find((tool) => tool.name === 'systemd_unit_list');
  assert.equal(list.inputSchema.additionalProperties, false);
  assert.equal(list.inputSchema.properties.limit.maximum, 200);
  assert.deepEqual(list.inputSchema.properties.type.enum, [
    'service', 'socket', 'timer', 'path', 'mount', 'automount', 'target', 'slice', 'scope',
  ]);
  const action = SYSTEMD_TOOLS.find((tool) => tool.name === 'systemd_unit_action');
  assert.deepEqual(action.inputSchema.properties.action.enum, [
    'start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart',
    'enable', 'disable', 'reenable', 'mask', 'unmask', 'reset-failed',
  ]);
  assert.deepEqual(action.inputSchema.properties.privilege.enum, ['auto', 'user', 'root']);
  assert.equal(action.inputSchema.properties.privilege.default, 'auto');
  const daemonReload = SYSTEMD_TOOLS.find((tool) => tool.name === 'systemd_daemon_reload');
  assert.equal(daemonReload.inputSchema.properties.privilege.default, 'root');

  const escapedUnit = String.raw`systemd-fsck@dev-disk-by\x2duuid-20C2\x2dF69E.service`;
  for (const name of ['systemd_unit_status', 'systemd_unit_dependencies', 'systemd_unit_action']) {
    const unitSchema = SYSTEMD_TOOLS.find((tool) => tool.name === name).inputSchema.properties.unit;
    const pattern = new RegExp(unitSchema.pattern, 'u');
    assert.equal(pattern.test(escapedUnit), true, `${name} schema must accept canonical systemd hex escapes`);
    assert.equal(pattern.test(String.raw`bad\escape.service`), false, `${name} schema must reject arbitrary backslashes`);
  }
});

test('systemd tool handler delegates to the exact injected core primitive', async () => {
  const calls = [];
  const response = await callSystemdTool(
    'systemd_unit_status',
    { target: 'test-host', unit: 'demo.socket' },
    {
      statusImpl: async (args) => { calls.push({ type: 'status', args }); return statusResult(); },
      listImpl: async () => { throw new Error('not list'); },
      dependenciesImpl: async () => { throw new Error('not dependencies'); },
    },
  );
  assert.deepEqual(calls, [{ type: 'status', args: { target: 'test-host', unit: 'demo.socket' } }]);
  assert.deepEqual(response.structuredContent, statusResult());
  assert.equal(response.isError, undefined);
});

test('systemd tool failures retain normalized MCP error contract', async () => {
  const response = await callSystemdTool(
    'systemd_unit_dependencies',
    { target: 'test-host', unit: 'missing.timer' },
    {
      dependenciesImpl: async () => {
        throw new TerminalError('remote_command_nonzero_exit', 'Unit missing.timer not found');
      },
    },
  );
  assert.equal(response.isError, true);
  assert.deepEqual(response.structuredContent, {
    category: 'remote_command_nonzero_exit',
    message: 'Unit missing.timer not found',
    retryable: false,
  });
});

test('unified registry routes generic systemd tools locally and never forwards upstream', async () => {
  const calls = [];
  const response = await callTool(
    'systemd_unit_list',
    { target: 'test-host', type: 'timer', limit: 20 },
    {
      upstreamClient: { callTool: async () => { throw new Error('must not call upstream'); } },
      upstreamToolNames: new Set(),
      systemdToolCallImpl: async (name, args) => {
        calls.push({ name, args });
        return { content: [], structuredContent: { target: 'test-host', type: 'timer', units: [], results_truncated: false } };
      },
    },
  );
  assert.deepEqual(calls, [{ name: 'systemd_unit_list', args: { target: 'test-host', type: 'timer', limit: 20 } }]);
  assert.deepEqual(response.structuredContent.units, []);
});

test('systemd mutation tool handler delegates shared user/root execution dependencies', async () => {
  const remoteCalls = [];
  const rootCalls = [];
  const response = await callSystemdTool(
    'systemd_unit_action',
    { target: 'test-host', unit: 'demo.service', action: 'restart', privilege: 'root' },
    {
      remoteExecImpl: async (request) => { remoteCalls.push(request); return { exit_code: 0 }; },
      rootExecImpl: async (request) => {
        rootCalls.push(structuredClone(request));
        return {
          strategy: 'docker_host_root', target: 'test-host',
          exit_code: 0, stdout: '', stderr: '', duration_ms: 1, timed_out: false, truncated: false,
        };
      },
    },
  );
  assert.equal(remoteCalls.length, 0);
  assert.equal(rootCalls.length, 1);
  assert.equal(response.structuredContent.actual_privilege, 'root');
  assert.equal(response.structuredContent.unit, 'demo.service');
});

