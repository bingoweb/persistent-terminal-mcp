import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { getTerminalHealth } from '../../src/health-tool.mjs';
import { LEGACY_ALIAS_SPECS } from '../../src/legacy-aliases.mjs';
import { createProductionRuntime, createServer } from '../../src/server.mjs';
import { callTargetTool } from '../../src/target-tools.mjs';
import { LOCAL_TOOLS } from '../../src/tool-registry.mjs';

const HOST = process.env.PTY_MCP_SMOKE_HOST;
const ANNOTATION_KEYS = ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function activeCounts(health) {
  return {
    sessions: health.counts.sessions.active,
    tasks: health.counts.tasks.active,
    forwards: health.counts.forwards.active,
    remote_sessions: health.targets.find((entry) => entry.target === HOST)?.remote_sessions ?? null,
  };
}

function assertNoLifecycleIncrease(before, after) {
  for (const field of ['sessions', 'tasks', 'forwards']) {
    assert(after[field] <= before[field], `${field} leaked: ${before[field]} -> ${after[field]}`);
  }
  if (before.remote_sessions !== null && after.remote_sessions !== null) {
    assert(
      after.remote_sessions <= before.remote_sessions,
      `remote_sessions leaked: ${before.remote_sessions} -> ${after.remote_sessions}`,
    );
  }
}

function assertAnnotations(tool) {
  assert(tool?.annotations && typeof tool.annotations === 'object', `${tool?.name} missing annotations`);
  const keys = Object.keys(tool.annotations).sort();
  assert(JSON.stringify(keys) === JSON.stringify(ANNOTATION_KEYS), `${tool.name} annotation keys mismatch: ${keys}`);
  for (const key of ANNOTATION_KEYS) {
    assert(typeof tool.annotations[key] === 'boolean', `${tool.name}.${key} must be boolean`);
  }
}

async function protocolCatalogAcceptance() {
  const upstreamReadAnnotations = Object.freeze({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  const upstreamRead = Object.freeze({
    name: 'read_output',
    description: 'live upstream annotation sentinel',
    inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
    annotations: upstreamReadAnnotations,
  });
  const upstreamSentinel = Object.freeze({
    name: 'upstream_protocol_sentinel',
    description: 'must remain untouched',
    inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  });
  const upstreamTools = [upstreamRead, upstreamSentinel];
  const server = createServer({
    upstreamClient: {
      listTools: async () => ({ tools: upstreamTools }),
      callTool: async () => { throw new Error('protocol catalog acceptance must not invoke upstream tools'); },
    },
  });
  const client = new Client({ name: 'ptext-protocol-release-live', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const expectedLocalNames = new Set([
      ...LOCAL_TOOLS.map((tool) => tool.name),
      ...LEGACY_ALIAS_SPECS.map((spec) => spec.name),
    ]);
    for (const name of expectedLocalNames) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert(tool, `tools/list missing extension-owned tool ${name}`);
      assertAnnotations(tool);
    }
    const listedRead = listed.tools.find((tool) => tool.name === 'read_output');
    const listedSentinel = listed.tools.find((tool) => tool.name === 'upstream_protocol_sentinel');
    assert(JSON.stringify(listedRead.annotations) === JSON.stringify(upstreamReadAnnotations), 'upstream read_output annotations changed');
    assert(JSON.stringify(listedSentinel) === JSON.stringify(upstreamSentinel), 'upstream sentinel tool changed');
    return { local_tools: expectedLocalNames.size, upstream_tools: upstreamTools.length };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function main() {
  if (!HOST) throw new Error('PTY_MCP_SMOKE_HOST is required');
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ptext-protocol-live-'));
  const runtime = createProductionRuntime({
    homeDir: tempHome,
    env: {
      ...process.env,
      PTEXT_SSH_MULTIPLEX: 'auto',
      PTEXT_SSH_CONTROL_PERSIST_SECONDS: '120',
      PTEXT_SSH_CONTROL_MAX_TARGETS: '4',
      PTEXT_CAPABILITY_CACHE_TTL_SECONDS: '120',
    },
  });

  let baseline;
  try {
    const catalog = await protocolCatalogAcceptance();
    const healthDeps = {
      upstreamClient: runtime.upstreamClient,
      remoteExecImpl: runtime.remoteExecImpl,
      telemetry: runtime.telemetry,
      multiplexManager: runtime.multiplexManager,
      capabilityInventory: runtime.capabilityInventory,
      privilegeEngine: runtime.privilegeEngine,
    };
    baseline = await getTerminalHealth(
      { targets: [HOST], include_remote_sessions: true },
      healthDeps,
    );
    assert(baseline.extension.healthy === true, `source baseline extension unhealthy: ${JSON.stringify(baseline)}`);
    assert(baseline.upstream.healthy === true, `source baseline upstream unhealthy: ${JSON.stringify(baseline)}`);

    const capabilitiesResponse = await callTargetTool(
      'target_capabilities',
      { target: HOST, refresh: true },
      { capabilityInventory: runtime.capabilityInventory },
    );
    assert(capabilitiesResponse.isError !== true, `target_capabilities failed: ${JSON.stringify(capabilitiesResponse)}`);
    const capabilities = capabilitiesResponse.structuredContent;
    assert(capabilities.target === HOST, 'target_capabilities target mismatch');
    assert(capabilities.capabilities?.systemctl?.available === true, 'taylan must expose systemctl for protocol acceptance');
    assert(capabilities.capabilities?.['ai-tmux']?.available === true, 'taylan must expose ai-tmux for protocol acceptance');

    const diagnosticResponse = await callTargetTool(
      'target_diagnose',
      { target: HOST, refresh: false },
      {
        capabilityInventory: runtime.capabilityInventory,
        multiplexManager: runtime.multiplexManager,
        privilegeEngine: runtime.privilegeEngine,
        telemetry: runtime.telemetry,
        remoteExecImpl: runtime.remoteExecImpl,
      },
    );
    assert(diagnosticResponse.isError !== true, `target_diagnose MCP failure: ${JSON.stringify(diagnosticResponse)}`);
    const diagnostic = diagnosticResponse.structuredContent;
    assert(diagnostic.state === 'available', `target_diagnose not fully available: ${JSON.stringify(diagnostic)}`);
    assert(diagnostic.transport.state === 'available', 'transport diagnostic unavailable');
    assert(diagnostic.transport.multiplex.active === true, `multiplex not active: ${JSON.stringify(diagnostic.transport.multiplex)}`);
    assert(diagnostic.remote_identity.state === 'available', 'remote identity unavailable');
    assert(diagnostic.system.state === 'available', `system diagnostic failed: ${JSON.stringify(diagnostic.system)}`);
    assert(diagnostic.system.os?.id === 'ubuntu', `unexpected OS: ${JSON.stringify(diagnostic.system.os)}`);
    assert(typeof diagnostic.system.kernel === 'string' && diagnostic.system.kernel.length > 0, 'kernel missing');
    assert(['available', 'permission_limited'].includes(diagnostic.privilege.state), `unexpected privilege state: ${diagnostic.privilege.state}`);
    assert(diagnostic.ai_tmux.state === 'available', `ai-tmux diagnostic unavailable: ${JSON.stringify(diagnostic.ai_tmux)}`);
    assert(diagnostic.disk_pressure.state === 'available', `disk pressure unavailable: ${JSON.stringify(diagnostic.disk_pressure)}`);
    assert(diagnostic.failed_systemd_units.state === 'available', `failed-systemd summary unavailable: ${JSON.stringify(diagnostic.failed_systemd_units)}`);
    assert(['available', 'not_applicable'].includes(diagnostic.gpu.state), `unexpected GPU diagnostic: ${JSON.stringify(diagnostic.gpu)}`);
    assert(diagnostic.capability_cache.state === 'available', 'capability cache diagnostic unavailable');
    assert(diagnostic.telemetry.state === 'available', 'telemetry diagnostic unavailable');
    assert(JSON.stringify(diagnostic).includes('target_hashes') === false, 'diagnostic leaked capability target hashes');
    assert(JSON.stringify(diagnostic).includes('control_path') === false, 'diagnostic leaked ControlPath');

    const finalHealth = await getTerminalHealth(
      { targets: [HOST], include_remote_sessions: true },
      healthDeps,
    );
    assertNoLifecycleIncrease(activeCounts(baseline), activeCounts(finalHealth));
    assert(finalHealth.runtime.telemetry.state === 'available', 'health telemetry unavailable');
    assert(finalHealth.runtime.multiplex.state === 'available', 'health multiplex unavailable');
    assert(finalHealth.runtime.capability_cache.state === 'available', 'health capability cache unavailable');
    assert(finalHealth.runtime.privilege_cache.state === 'available', 'health privilege cache unavailable');

    process.stdout.write(`${JSON.stringify({
      marker: 'PROTOCOL_RELEASE_LIVE_OK',
      target: HOST,
      catalog,
      diagnostic: {
        state: diagnostic.state,
        os: diagnostic.system.os,
        kernel: diagnostic.system.kernel,
        privilege: diagnostic.privilege.state,
        ai_tmux: diagnostic.ai_tmux,
        disk_pressure: diagnostic.disk_pressure,
        failed_systemd_units: diagnostic.failed_systemd_units,
        gpu: diagnostic.gpu,
        capability_cache: diagnostic.capability_cache,
      },
      runtime: finalHealth.runtime,
      lifecycle_before: activeCounts(baseline),
      lifecycle_after: activeCounts(finalHealth),
    })}\n`);
  } finally {
    await runtime.multiplexManager.closeAll().catch(() => {});
    await runtime.upstreamClient.close().catch(() => {});
    await runtime.server.close().catch(() => {});
    await runtime.logger.close?.().catch(() => {});
    await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
