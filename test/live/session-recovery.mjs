import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../../src/server.mjs';
import { callSessionTool } from '../../src/session-tools.mjs';
import { createStateStore } from '../../src/state-store.mjs';
import { PtyUpstreamClient } from '../../src/upstream-pty.mjs';
import { resolveTarget } from '../../src/target-resolver.mjs';

const CHILD_FLAG = '--extension-child';
const STATE_ENV = 'PERSISTENT_TERMINAL_LIVE_STATE_PATH';
const HOST = process.env.PTY_MCP_SMOKE_HOST;
const NAME = process.env.PERSISTENT_TERMINAL_RECOVERY_NAME ?? 'extended-recovery-smoke';
const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '../..');

function parseToolJson(result, fallback = {}) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return fallback;
  return JSON.parse(text);
}

function remoteSessionId(entry) {
  return entry?.id ?? entry?.session_id ?? null;
}

function assertToolSuccess(result, name) {
  if (result?.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  }
  return result;
}

async function runExtensionChild() {
  const statePath = process.env[STATE_ENV];
  if (!statePath) throw new Error(`${STATE_ENV} is required in extension child mode`);

  const stateStore = createStateStore(statePath);
  const upstreamClient = new PtyUpstreamClient();
  const sessionToolCallImpl = (toolName, args, { upstreamClient: shared }) =>
    callSessionTool(toolName, args, { stateStore, upstreamClient: shared });
  const server = createServer({ upstreamClient, sessionToolCallImpl });
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => {});
    await upstreamClient.close().catch(() => {});
  };
  process.once('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    shutdown().finally(() => process.exit(130));
  });

  await server.connect(transport);
}

async function startExtension(statePath, ordinal) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [THIS_FILE, CHILD_FLAG],
    cwd: PACKAGE_ROOT,
    env: {
      [STATE_ENV]: statePath,
      ...(process.env.PTY_UPSTREAM_URL ? { PTY_UPSTREAM_URL: process.env.PTY_UPSTREAM_URL } : {}),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client({
    name: `persistent-terminal-recovery-live-${ordinal}`,
    version: '1.0.0',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const toolName of ['ensure_session', 'named_session_detach', 'named_session_close']) {
      if (!listed.tools.some((tool) => tool.name === toolName)) {
        throw new Error(`extension child ${ordinal} missing tool ${toolName}`);
      }
    }
  } catch (error) {
    await client.close().catch(() => {});
    throw new Error(
      `extension child ${ordinal} failed to start${stderr ? `: ${stderr.trim()}` : ''}`,
      { cause: error },
    );
  }

  if (!Number.isInteger(transport.pid)) {
    await client.close().catch(() => {});
    throw new Error(`extension child ${ordinal} has no process pid`);
  }
  return { client, transport, pid: transport.pid, stderr: () => stderr };
}

async function upstreamJson(upstream, name, args) {
  const result = await upstream.callTool(name, args);
  if (result?.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  }
  return parseToolJson(result);
}

async function remoteSessions(upstream, user) {
  const result = await upstreamJson(upstream, 'list_remote_sessions', { host: HOST, user });
  if (!Array.isArray(result)) throw new Error('list_remote_sessions did not return an array');
  return result;
}

async function cleanupRemote(upstream, user, remoteId, localId) {
  if (localId) {
    try {
      await upstream.callTool('close_session', { session_id: localId });
      return;
    } catch {}
  }
  if (!remoteId) return;

  try {
    const remotes = await remoteSessions(upstream, user);
    if (!remotes.some((item) => remoteSessionId(item) === remoteId)) return;
    const attached = await upstreamJson(upstream, 'create_ssh_session', {
      host: HOST,
      user,
      persistent: true,
      session_id: remoteId,
    });
    if (attached?.session_id) {
      await upstream.callTool('close_session', { session_id: attached.session_id });
    }
  } catch {}
}

async function runParent() {
  if (!HOST) {
    throw new Error('PTY_MCP_SMOKE_HOST is required for the live recovery test');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-live-recovery-'));
  const statePath = path.join(tempDir, 'state.json');
  const marker = `EXTENDED_RECOVERY_${Date.now()}_${process.pid}`;
  const readyLine = `__${marker}_READY__`;
  const tokenLine = `__${marker}_TOKEN_OK__`;
  const upstream = new PtyUpstreamClient();
  const resolved = await resolveTarget(HOST);
  const user = process.env.PTY_MCP_SMOKE_USER ?? resolved.user;
  if (!user) throw new Error(`OpenSSH target ${HOST} did not resolve a user`);

  let first = null;
  let second = null;
  let remoteId = null;
  let activeLocalId = null;

  try {
    const before = await remoteSessions(upstream, user);
    const beforeIds = new Set(before.map(remoteSessionId).filter(Boolean));

    first = await startExtension(statePath, 1);
    const ensured = assertToolSuccess(await first.client.callTool({
      name: 'ensure_session',
      arguments: { name: NAME, target: HOST, cwd: '/tmp', tags: ['live-recovery'] },
    }), 'ensure_session');
    activeLocalId = ensured.structuredContent.session_id;
    remoteId = ensured.structuredContent.remote_session_id;
    if (ensured.structuredContent.reused || ensured.structuredContent.recovered) {
      throw new Error(`fresh state unexpectedly reused a session: ${JSON.stringify(ensured.structuredContent)}`);
    }

    const sent = await upstreamJson(upstream, 'send_input', {
      session_id: activeLocalId,
      input: `export EXTENDED_RECOVERY_TOKEN=${marker}; printf '\\n${readyLine}\\n'`,
      wait_for: `^${readyLine}$`,
      wait_for_timeout: 15,
    });
    if (sent.matched !== true || sent.match_line !== readyLine) {
      throw new Error(`anchored marker setup failed: ${JSON.stringify(sent)}`);
    }

    const afterCreate = await remoteSessions(upstream, user);
    const createdIds = afterCreate
      .filter((item) => item?.is_alive !== false)
      .map(remoteSessionId)
      .filter((id) => id && !beforeIds.has(id));
    if (createdIds.length !== 1 || createdIds[0] !== remoteId) {
      throw new Error(`expected one new remote session ${remoteId}, got ${JSON.stringify(createdIds)}`);
    }

    const detached = assertToolSuccess(await first.client.callTool({
      name: 'named_session_detach',
      arguments: { name: NAME },
    }), 'named_session_detach');
    if (detached.structuredContent.remote_session_id !== remoteId) {
      throw new Error(`detach changed remote identity: ${JSON.stringify(detached.structuredContent)}`);
    }
    activeLocalId = null;

    const firstPid = first.pid;
    await first.client.close();
    first = null;

    second = await startExtension(statePath, 2);
    const secondPid = second.pid;
    if (secondPid === firstPid) {
      throw new Error(`extension process did not restart: pid remained ${firstPid}`);
    }

    const recovered = assertToolSuccess(await second.client.callTool({
      name: 'ensure_session',
      arguments: { name: NAME, target: HOST },
    }), 'ensure_session after restart');
    activeLocalId = recovered.structuredContent.session_id;
    if (recovered.structuredContent.remote_session_id !== remoteId) {
      throw new Error(`remote identity changed after restart: ${JSON.stringify(recovered.structuredContent)}`);
    }
    if (recovered.structuredContent.reused !== true && recovered.structuredContent.recovered !== true) {
      throw new Error(`restart did not report reuse/recovery: ${JSON.stringify(recovered.structuredContent)}`);
    }

    const verified = await upstreamJson(upstream, 'send_input', {
      session_id: activeLocalId,
      input: `test \"$EXTENDED_RECOVERY_TOKEN\" = \"${marker}\" && printf '\\n${tokenLine}\\n'`,
      wait_for: `^${tokenLine}$`,
      wait_for_timeout: 15,
    });
    if (verified.matched !== true || verified.match_line !== tokenLine) {
      throw new Error(`environment marker did not survive extension restart: ${JSON.stringify(verified)}`);
    }

    const afterRecovery = await remoteSessions(upstream, user);
    const matchingRemote = afterRecovery.filter((item) => remoteSessionId(item) === remoteId);
    const newIdsAfterRecovery = afterRecovery
      .filter((item) => item?.is_alive !== false)
      .map(remoteSessionId)
      .filter((id) => id && !beforeIds.has(id));
    if (matchingRemote.length !== 1 || newIdsAfterRecovery.length !== 1) {
      throw new Error(
        `duplicate remote session detected after recovery: matching=${matchingRemote.length} new=${JSON.stringify(newIdsAfterRecovery)}`,
      );
    }

    const closed = assertToolSuccess(await second.client.callTool({
      name: 'named_session_close',
      arguments: { name: NAME },
    }), 'named_session_close');
    if (closed.structuredContent.closed !== true) {
      throw new Error(`named session did not close: ${JSON.stringify(closed.structuredContent)}`);
    }
    activeLocalId = null;

    const finalRemotes = await remoteSessions(upstream, user);
    if (finalRemotes.some((item) => remoteSessionId(item) === remoteId)) {
      throw new Error(`remote session ${remoteId} survived named_session_close`);
    }

    process.stdout.write(
      `EXTENDED_SESSION_RECOVERY_OK remote_session=${remoteId} first_pid=${firstPid} second_pid=${secondPid}\n`,
    );
  } finally {
    if (first) await first.client.close().catch(() => {});
    if (second) await second.client.close().catch(() => {});
    await cleanupRemote(upstream, user, remoteId, activeLocalId);
    await upstream.close().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv.includes(CHILD_FLAG)) {
  runExtensionChild().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
} else {
  runParent().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
