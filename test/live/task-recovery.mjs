import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from '../../src/server.mjs';
import { createStateStore } from '../../src/state-store.mjs';
import {
  cancelTask,
  getTaskStatus,
  listTasks,
  readTaskOutput,
  startTask,
  waitForTask,
} from '../../src/task-manager.mjs';
import { callTaskTool } from '../../src/task-tools.mjs';
import { resolveTarget } from '../../src/target-resolver.mjs';
import { PtyUpstreamClient } from '../../src/upstream-pty.mjs';

const CHILD_FLAG = '--extension-child';
const STATE_ENV = 'PERSISTENT_TERMINAL_LIVE_TASK_STATE_PATH';
const HOST = process.env.PTY_MCP_SMOKE_HOST;
const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '../..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseToolJson(result, fallback = {}) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return fallback;
  return JSON.parse(text);
}

function assertToolSuccess(result, name) {
  if (result?.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(parseToolJson(result))}`);
  }
  return parseToolJson(result);
}

function remoteSessionId(entry) {
  return entry?.id ?? entry?.session_id ?? null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskManagerFor(stateStore, upstreamClient) {
  return {
    start: (args) => startTask(args, { stateStore, upstreamClient }),
    status: (taskId) => getTaskStatus(taskId, { stateStore, upstreamClient }),
    output: (taskId, options) => readTaskOutput(taskId, {
      ...options,
      stateStore,
      upstreamClient,
    }),
    wait: (taskId, options) => waitForTask(taskId, {
      ...options,
      stateStore,
      upstreamClient,
    }),
    cancel: (taskId, options) => cancelTask(taskId, {
      ...options,
      stateStore,
      upstreamClient,
    }),
    list: () => listTasks({ stateStore }),
  };
}

async function runExtensionChild() {
  const statePath = process.env[STATE_ENV];
  if (!statePath) throw new Error(`${STATE_ENV} is required in extension child mode`);

  const stateStore = createStateStore(statePath);
  const upstreamClient = new PtyUpstreamClient();
  const taskManager = taskManagerFor(stateStore, upstreamClient);
  const taskToolCallImpl = (toolName, args) => callTaskTool(toolName, args, { taskManager });
  const server = createServer({ upstreamClient, taskToolCallImpl });
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
    name: `persistent-terminal-task-recovery-live-${ordinal}`,
    version: '1.0.0',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const toolName of ['task_start', 'task_status', 'task_output', 'task_wait', 'task_list']) {
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

async function waitForTaskOutput(client, taskId, needle) {
  let combined = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = assertToolSuccess(await client.callTool({
      name: 'task_output',
      arguments: { task_id: taskId, max_bytes: 32768 },
    }), 'task_output before restart');
    combined += read.output;
    if (combined.includes(needle)) return combined;
    await delay(250);
  }
  throw new Error(`task output did not contain ${needle}: ${JSON.stringify(combined)}`);
}

async function collectRemainingOutput(client, taskId) {
  let output = '';
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const read = assertToolSuccess(await client.callTool({
      name: 'task_output',
      arguments: { task_id: taskId, max_bytes: 262144 },
    }), 'task_output after recovery');
    output += read.output;
    if (!read.has_more) return output;
  }
  throw new Error('task output remained truncated after bounded recovery reads');
}

async function stopExtensionAbruptly(extension) {
  const pid = extension.pid;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await extension.client.close().catch(() => {});

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`extension process ${pid} remained alive after SIGKILL`);
}

async function runParent() {
  if (!HOST) {
    throw new Error('PTY_MCP_SMOKE_HOST is required for the live task recovery test');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-live-task-recovery-'));
  const statePath = path.join(tempDir, 'state.json');
  const unique = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const beginPrefix = `__PTEXT_LIVE_TASK_${unique}_BEGIN__`;
  const tickPrefix = `__PTEXT_LIVE_TASK_${unique}_TICK_`;
  const donePrefix = `__PTEXT_LIVE_TASK_${unique}_DONE__`;
  const command = [
    `printf '${beginPrefix} %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    `for i in 1 2 3; do sleep 15; printf '${tickPrefix}%s__ %s\\n' "$i" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; done`,
    `printf '${donePrefix} %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
  ].join('; ');

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
    const firstPid = first.pid;
    const started = assertToolSuccess(await first.client.callTool({
      name: 'task_start',
      arguments: { target: HOST, command },
    }), 'task_start');
    const taskId = started.task_id;
    remoteId = started.remote_session_id;
    assert(typeof taskId === 'string' && taskId.startsWith('task_'), `invalid task id: ${JSON.stringify(started)}`);
    assert(started.state === 'running', `task did not enter running state: ${JSON.stringify(started)}`);
    assert(typeof remoteId === 'string' && remoteId.length > 0, `missing remote session id: ${JSON.stringify(started)}`);

    const initialOutput = await waitForTaskOutput(first.client, taskId, beginPrefix);
    assert(
      new RegExp(`${beginPrefix} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z`, 'u').test(initialOutput),
      `task did not emit timestamped initial output: ${JSON.stringify(initialOutput)}`,
    );

    const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert(persisted.tasks?.[taskId]?.remote_session_id === remoteId, 'task state was not persisted before restart');

    const afterCreate = await remoteSessions(upstream, user);
    const createdIds = afterCreate
      .filter((item) => item?.is_alive !== false)
      .map(remoteSessionId)
      .filter((id) => id && !beforeIds.has(id));
    assert(
      createdIds.length === 1 && createdIds[0] === remoteId,
      `task_start should create exactly one remote session ${remoteId}, got ${JSON.stringify(createdIds)}`,
    );

    await stopExtensionAbruptly(first);
    first = null;

    const afterKill = await remoteSessions(upstream, user);
    assert(
      afterKill.some((item) => remoteSessionId(item) === remoteId && item?.is_alive !== false),
      `remote task session ${remoteId} died with the local extension process`,
    );

    second = await startExtension(statePath, 2);
    const secondPid = second.pid;
    assert(secondPid !== firstPid, `extension process did not restart: pid remained ${firstPid}`);

    const reloaded = assertToolSuccess(await second.client.callTool({
      name: 'task_list',
      arguments: {},
    }), 'task_list after restart');
    assert(
      reloaded.tasks.length === 1 && reloaded.tasks[0].task_id === taskId,
      `restart did not reload exactly the original task: ${JSON.stringify(reloaded)}`,
    );

    const recovered = assertToolSuccess(await second.client.callTool({
      name: 'task_status',
      arguments: { task_id: taskId },
    }), 'task_status after restart');
    assert(recovered.task_id === taskId, `task id changed after restart: ${JSON.stringify(recovered)}`);
    assert(recovered.remote_session_id === remoteId, `remote identity changed after restart: ${JSON.stringify(recovered)}`);
    assert(recovered.state === 'running', `task did not recover as running: ${JSON.stringify(recovered)}`);

    const afterRecovery = await remoteSessions(upstream, user);
    const newIdsAfterRecovery = afterRecovery
      .filter((item) => item?.is_alive !== false)
      .map(remoteSessionId)
      .filter((id) => id && !beforeIds.has(id));
    assert(
      newIdsAfterRecovery.length === 1 && newIdsAfterRecovery[0] === remoteId,
      `recovery created a second remote session: ${JSON.stringify(newIdsAfterRecovery)}`,
    );

    const waited = assertToolSuccess(await second.client.callTool({
      name: 'task_wait',
      arguments: { task_id: taskId, timeout: 60 },
    }), 'task_wait after restart');
    assert(waited.task_id === taskId, `task_wait returned a different task id: ${JSON.stringify(waited)}`);
    assert(waited.remote_session_id === remoteId, `task_wait changed remote identity: ${JSON.stringify(waited)}`);
    assert(waited.timed_out === false, `task_wait timed out after recovery: ${JSON.stringify(waited)}`);
    assert(waited.state === 'succeeded' && waited.exit_code === 0, `recovered task did not succeed: ${JSON.stringify(waited)}`);

    const remainingOutput = await collectRemainingOutput(second.client, taskId);
    assert(
      new RegExp(`${tickPrefix}[123]__ \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z`, 'u').test(remainingOutput),
      `recovered task output did not contain timestamped ticks: ${JSON.stringify(remainingOutput)}`,
    );
    assert(
      new RegExp(`${donePrefix} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z`, 'u').test(remainingOutput),
      `recovered task output did not contain timestamped completion: ${JSON.stringify(remainingOutput)}`,
    );

    const finalTasks = assertToolSuccess(await second.client.callTool({
      name: 'task_list',
      arguments: {},
    }), 'task_list after completion');
    assert(
      finalTasks.tasks.length === 1
        && finalTasks.tasks[0].task_id === taskId
        && finalTasks.tasks[0].state === 'succeeded',
      `recovery duplicated or lost task state: ${JSON.stringify(finalTasks)}`,
    );

    const finalRemotes = await remoteSessions(upstream, user);
    const finalNewIds = finalRemotes
      .filter((item) => item?.is_alive !== false)
      .map(remoteSessionId)
      .filter((id) => id && !beforeIds.has(id));
    assert(
      finalNewIds.length === 1 && finalNewIds[0] === remoteId,
      `task completion/recovery created duplicate remote sessions: ${JSON.stringify(finalNewIds)}`,
    );

    const finalState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    activeLocalId = finalState.tasks?.[taskId]?.session_id ?? null;

    process.stdout.write(
      `EXTENDED_TASK_RECOVERY_OK task_id=${taskId} remote_session=${remoteId} first_pid=${firstPid} second_pid=${secondPid}\n`,
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
