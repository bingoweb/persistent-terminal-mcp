import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { PtyUpstreamClient } from './upstream-pty.mjs';
import { buildToolCatalog, callTool } from './tool-registry.mjs';
import { remoteExec } from './remote-exec.mjs';
import { createJsonlLogger } from './logger.mjs';
import { VERSION } from './version.mjs';

export function createServer({
  upstreamClient = new PtyUpstreamClient(),
  remoteExecImpl = remoteExec,
  sessionToolCallImpl,
  remoteFsToolCallImpl,
  taskToolCallImpl,
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
      sessionToolCallImpl,
      remoteFsToolCallImpl,
      taskToolCallImpl,
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
} = {}) {
  const logPath = env.PTEXT_LOG_PATH
    ?? path.join(homeDir, '.local', 'share', 'persistent-terminal-extended', 'diagnostics.jsonl');
  const logger = loggerFactory({ path: logPath });
  const upstreamClient = new UpstreamClientImpl({ logger });
  const server = createServer({ upstreamClient });
  return Object.freeze({ server, logger, upstreamClient, logPath });
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
