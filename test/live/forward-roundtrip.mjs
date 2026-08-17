import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { probeLocalTcp } from '../../src/forward-tools.mjs';

const HOST = process.env.PTY_MCP_SMOKE_HOST;
const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '../..');

function parseToolJson(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error(`tool result has no JSON payload: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text);
}

function assertToolSuccess(result, name) {
  if (result?.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(parseToolJson(result))}`);
  }
  return parseToolJson(result);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freeLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to allocate a local TCP port');
  }
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fetchForwardedHttp(port) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1500),
      });
      const body = await response.text();
      if (response.ok && /Directory listing|<!DOCTYPE HTML>/iu.test(body)) return body;
      lastError = new Error(`unexpected HTTP response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error('forwarded HTTP service did not become available');
}

async function run() {
  if (!HOST) {
    throw new Error('PTY_MCP_SMOKE_HOST is required for the live forward round-trip test');
  }

  const unique = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const name = `forward-live-${unique}`;
  const localPort = await freeLocalPort();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.mjs'],
    cwd: PACKAGE_ROOT,
    env: {
      ...(process.env.PTY_UPSTREAM_URL ? { PTY_UPSTREAM_URL: process.env.PTY_UPSTREAM_URL } : {}),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client({
    name: 'persistent-terminal-forward-live',
    version: '1.0.0',
  });
  const call = async (toolName, arguments_) => client.callTool({ name: toolName, arguments: arguments_ });

  let remoteHttpPid = null;
  let forwardId = null;
  let remotePort = null;

  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(
        `extension failed to start${stderr ? `: ${stderr.trim()}` : ''}`,
        { cause: error },
      );
    }

    const listed = await client.listTools();
    for (const toolName of [
      'remote_exec',
      'forward_create',
      'forward_list',
      'forward_status',
      'forward_close',
    ]) {
      assert(listed.tools.some((tool) => tool.name === toolName), `missing canonical tool ${toolName}`);
    }

    for (let attempt = 0; attempt < 8 && remoteHttpPid === null; attempt += 1) {
      const candidatePort = 20000 + Math.floor(Math.random() * 30000);
      const start = assertToolSuccess(await call('remote_exec', {
        target: HOST,
        command: 'nohup python3 -m http.server "$PERSISTENT_TERMINAL_HTTP_PORT" --bind 127.0.0.1 >/dev/null 2>&1 < /dev/null & pid=$!; sleep 0.3; if kill -0 "$pid" 2>/dev/null; then printf "%s\\n" "$pid"; else wait "$pid"; exit $?; fi',
        env: { PERSISTENT_TERMINAL_HTTP_PORT: String(candidatePort) },
        timeout_ms: 5000,
        max_output_bytes: 4096,
      }), 'remote_exec start HTTP server');
      if (start.exit_code !== 0 || start.timed_out || start.truncated) continue;
      const pid = Number.parseInt(start.stdout.trim(), 10);
      if (!Number.isInteger(pid) || pid < 1) continue;
      remoteHttpPid = pid;
      remotePort = candidatePort;
    }
    assert(remoteHttpPid !== null && remotePort !== null, 'failed to start temporary remote HTTP server');

    const createArgs = {
      name,
      target: HOST,
      type: 'local',
      bind_address: '127.0.0.1',
      listen_port: localPort,
      destination_host: '127.0.0.1',
      destination_port: remotePort,
    };

    const created = assertToolSuccess(await call('forward_create', createArgs), 'forward_create');
    forwardId = created.forward_id;
    assert(created.reused === false, `first forward create unexpectedly reused: ${JSON.stringify(created)}`);
    assert(created.health?.state === 'healthy', `new forward is not healthy: ${JSON.stringify(created)}`);
    assert(Number.isInteger(created.pid) && created.pid > 0, `forward has invalid pid: ${JSON.stringify(created)}`);
    assert(typeof created.process_started_at === 'string' && created.process_started_at.length > 0, 'missing public process start metadata');
    assert(!('process_identity' in created), 'private process identity leaked from forward_create');

    await fetchForwardedHttp(localPort);

    const status = assertToolSuccess(await call('forward_status', { forward_id: forwardId }), 'forward_status');
    assert(status.health?.state === 'healthy', `forward_status is not healthy: ${JSON.stringify(status)}`);
    assert(status.pid === created.pid, `forward pid changed unexpectedly: ${JSON.stringify(status)}`);
    assert(!('process_identity' in status), 'private process identity leaked from forward_status');

    const reused = assertToolSuccess(await call('forward_create', createArgs), 'forward_create reuse');
    assert(reused.reused === true, `named forward was not reused: ${JSON.stringify(reused)}`);
    assert(reused.forward_id === forwardId, `named reuse created a different forward id: ${JSON.stringify(reused)}`);
    assert(reused.pid === created.pid, `named reuse created a different ssh process: ${JSON.stringify(reused)}`);

    const all = assertToolSuccess(await call('forward_list', {}), 'forward_list');
    const matching = all.forwards.filter((item) => item.name === name);
    assert(matching.length === 1, `named forward was duplicated: ${JSON.stringify(matching)}`);

    const closed = assertToolSuccess(await call('forward_close', { name }), 'forward_close');
    assert(closed.closed === true && closed.forward_id === forwardId, `forward_close mismatch: ${JSON.stringify(closed)}`);
    assert(closed.health?.state === 'closed', `closed forward health mismatch: ${JSON.stringify(closed)}`);
    forwardId = null;

    assert(
      await probeLocalTcp('127.0.0.1', localPort, { timeoutMs: 250 }) === false,
      'local forward listener remains reachable after forward_close',
    );

    const afterClose = assertToolSuccess(await call('forward_list', {}), 'forward_list after close');
    assert(
      afterClose.forwards.every((item) => item.name !== name),
      `closed forward remains in persistent registry: ${JSON.stringify(afterClose)}`,
    );

    process.stdout.write(
      `FORWARD_ROUNDTRIP_OK forward_name=${name} local_port=${localPort} remote_port=${remotePort} reused=true closed=true\n`,
    );
  } finally {
    if (forwardId !== null) {
      await call('forward_close', { forward_id: forwardId }).catch(() => {});
    }
    if (remoteHttpPid !== null) {
      await call('remote_exec', {
        target: HOST,
        command: 'if kill -0 "$PERSISTENT_TERMINAL_HTTP_PID" 2>/dev/null; then kill "$PERSISTENT_TERMINAL_HTTP_PID"; fi',
        env: { PERSISTENT_TERMINAL_HTTP_PID: String(remoteHttpPid) },
        timeout_ms: 5000,
        max_output_bytes: 4096,
      }).catch(() => {});
    }
    await client.close().catch(() => {});
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
