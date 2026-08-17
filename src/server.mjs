import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { PtyUpstreamClient } from './upstream-pty.mjs';
import { buildToolCatalog, callTool } from './tool-registry.mjs';
import { remoteExec } from './remote-exec.mjs';
import { runSshCommand } from './ssh-runner.mjs';
import { createSshMultiplexManager } from './ssh-multiplex-manager.mjs';
import { createCapabilityInventory } from './target-capabilities.mjs';
import { callTargetTool } from './target-tools.mjs';
import { createTelemetry } from './telemetry.mjs';
import { remoteRootExec } from './root-exec.mjs';
import { createPrivilegeEngine } from './privilege-engine.mjs';
import { callSystemTool } from './system-tools.mjs';
import { callSystemdTool } from './systemd-tools.mjs';
import { systemdUnitAction, systemdUnitStatus } from './systemd-core.mjs';
import { callRemoteFs } from './remote-fs-client.mjs';
import { callRemoteFsTool } from './remote-fs-tools.mjs';
import { callTerminalHealthTool } from './health-tool.mjs';
import { createAdminTransactionEngine } from './admin-transaction.mjs';
import { callAdminTool } from './admin-tools.mjs';
import { createJsonlLogger } from './logger.mjs';
import { VERSION } from './version.mjs';

export function createServer({
  upstreamClient = new PtyUpstreamClient(),
  remoteExecImpl = remoteExec,
  rootExecImpl,
  adminToolCallImpl,
  sessionToolCallImpl,
  remoteFsToolCallImpl,
  taskToolCallImpl,
  systemToolCallImpl,
  systemdToolCallImpl,
  targetToolCallImpl,
  healthToolCallImpl,
} = {}) {
  const server = new Server(
    { name: 'persistent-terminal-extended', version: VERSION },
    { capabilities: { tools: {} } },
  );

  let cachedCatalog = null;
  let upstreamToolNames = null;

  async function loadCatalog({ refresh = false } = {}) {
    if (!refresh && cachedCatalog && upstreamToolNames) {
      return { catalog: cachedCatalog, upstreamToolNames };
    }

    const response = await upstreamClient.listTools();
    const tools = Array.isArray(response) ? response : response?.tools;
    if (!Array.isArray(tools)) throw new TypeError('pty-mcp listTools response did not contain a tools array');

    cachedCatalog = buildToolCatalog({ upstreamTools: tools });
    upstreamToolNames = new Set(tools.map((tool) => tool.name));
    return { catalog: cachedCatalog, upstreamToolNames };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { catalog } = await loadCatalog({ refresh: true });
    return { tools: catalog };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { upstreamToolNames: knownNames } = await loadCatalog();
    return callTool(request.params.name, request.params.arguments ?? {}, {
      upstreamClient,
      upstreamToolNames: knownNames,
      remoteExecImpl,
      rootExecImpl,
      adminToolCallImpl,
      sessionToolCallImpl,
      remoteFsToolCallImpl,
      taskToolCallImpl,
      systemToolCallImpl,
      systemdToolCallImpl,
      targetToolCallImpl,
      healthToolCallImpl,
    });
  });

  return server;
}

export function createProductionRuntime({
  homeDir = os.homedir(),
  env = process.env,
  loggerFactory = createJsonlLogger,
  UpstreamClientImpl = PtyUpstreamClient,
  telemetryFactory = createTelemetry,
  multiplexManagerFactory = createSshMultiplexManager,
  capabilityInventoryFactory = createCapabilityInventory,
  privilegeEngineFactory = createPrivilegeEngine,
  adminTransactionEngineFactory = createAdminTransactionEngine,
  healthImpl,
  runSshCommandImpl = runSshCommand,
} = {}) {
  const logPath = env.PTEXT_LOG_PATH
    ?? path.join(homeDir, '.local', 'share', 'persistent-terminal-extended', 'diagnostics.jsonl');
  const logger = loggerFactory({ path: logPath });
  const upstreamClient = new UpstreamClientImpl({ logger });
  const telemetry = telemetryFactory();
  const multiplexManager = multiplexManagerFactory({ env, homeDir, telemetry });
  const remoteExecImpl = (request) => remoteExec(request, {
    runner: (target, runnerRequest) => runSshCommandImpl(target, runnerRequest, {
      multiplexManager,
      telemetry,
    }),
  });
  const capabilityInventory = capabilityInventoryFactory({ env, remoteExecImpl, telemetry });
  const rootProviderExecImpl = (request, dependencies = {}) => remoteRootExec(request, {
    env,
    remoteExecImpl,
    upstreamClient: dependencies.upstreamClient ?? upstreamClient,
    providerOrder: dependencies.providerOrder,
    capabilityHint: dependencies.capabilityHint,
  });
  const privilegeEngine = privilegeEngineFactory({
    capabilityInventory,
    rootExecImpl: rootProviderExecImpl,
    telemetry,
  });
  const rootExecImpl = (request, { upstreamClient: suppliedClient } = {}) => privilegeEngine.execute(
    request,
    { upstreamClient: suppliedClient ?? upstreamClient },
  );
  const systemToolCallImpl = (name, args, { upstreamClient: suppliedClient } = {}) => callSystemTool(
    name,
    args,
    {
      remoteExecImpl,
      rootExecImpl,
      upstreamClient: suppliedClient ?? upstreamClient,
    },
  );
  const systemdToolCallImpl = (name, args) => callSystemdTool(name, args, { remoteExecImpl, rootExecImpl });
  const remoteFsToolCallImpl = (name, args) => callRemoteFsTool(name, args, {
    callRemoteFsImpl: (target, request) => callRemoteFs(target, request, { execImpl: remoteExecImpl }),
  });
  const remoteFsPrimitive = ({ target, ...request }) => callRemoteFs(
    target,
    request,
    { execImpl: remoteExecImpl },
  );
  const adminTransactionEngine = adminTransactionEngineFactory({
    remoteExecImpl,
    systemdActionImpl: (request) => systemdUnitAction(request, { remoteExecImpl, rootExecImpl }),
    systemdStatusImpl: (request) => systemdUnitStatus(request, { remoteExecImpl }),
    remoteStatImpl: ({ target, path: remotePath }) => remoteFsPrimitive({ target, op: 'stat', path: remotePath }),
    remoteReadImpl: ({ target, path: remotePath }) => remoteFsPrimitive({ target, op: 'read', path: remotePath }),
    remoteWriteImpl: ({ target, path: remotePath, text, expected_sha256 }) => remoteFsPrimitive({
      target,
      op: 'write',
      path: remotePath,
      text,
      expected_sha256,
    }),
    remotePatchImpl: ({ target, path: remotePath, hunks, expected_sha256 }) => remoteFsPrimitive({
      target,
      op: 'patch',
      path: remotePath,
      hunks,
      expected_sha256,
    }),
  });
  const adminToolCallImpl = (name, args) => callAdminTool(name, args, {
    transactionEngine: adminTransactionEngine,
  });
  const targetToolCallImpl = (name, args) => callTargetTool(name, args, {
    capabilityInventory,
    multiplexManager,
    privilegeEngine,
    telemetry,
    remoteExecImpl,
  });
  const healthToolCallImpl = (args, { upstreamClient: suppliedClient } = {}) => callTerminalHealthTool(
    args,
    {
      healthImpl,
      upstreamClient: suppliedClient ?? upstreamClient,
      remoteExecImpl,
      telemetry,
      multiplexManager,
      capabilityInventory,
      privilegeEngine,
    },
  );
  const server = createServer({
    upstreamClient,
    remoteExecImpl,
    rootExecImpl,
    adminToolCallImpl,
    remoteFsToolCallImpl,
    systemToolCallImpl,
    systemdToolCallImpl,
    targetToolCallImpl,
    healthToolCallImpl,
  });
  return Object.freeze({
    server,
    logger,
    upstreamClient,
    logPath,
    telemetry,
    multiplexManager,
    capabilityInventory,
    privilegeEngine,
    adminTransactionEngine,
    remoteExecImpl,
    rootExecImpl,
  });
}

export async function main() {
  const { server } = createProductionRuntime();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`persistent-terminal-extended failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
