import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { terminalDiagnostics } from './diagnostics.mjs';
import { TerminalError } from './errors.mjs';
import { VERSION } from './version.mjs';

const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:9021/mcp';
const DEFAULT_RECONNECT = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateReconnect(options = {}) {
  const merged = { ...DEFAULT_RECONNECT, ...options };
  for (const field of ['maxAttempts', 'baseDelayMs', 'maxDelayMs']) {
    if (!Number.isInteger(merged[field]) || merged[field] < 1) {
      throw new TypeError(`reconnect.${field} must be a positive integer`);
    }
  }
  if (merged.maxDelayMs < merged.baseDelayMs) {
    throw new TypeError('reconnect.maxDelayMs must be >= baseDelayMs');
  }
  if (typeof merged.jitterRatio !== 'number' || merged.jitterRatio < 0 || merged.jitterRatio > 1) {
    throw new TypeError('reconnect.jitterRatio must be between 0 and 1');
  }
  return Object.freeze(merged);
}

function reconnectError(error, attempts) {
  return new TerminalError(
    'transport_reconnect_failure',
    `Unable to connect to pty-mcp upstream after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
    { retryable: true, cause: error },
  );
}

function isDefinitiveSessionNotFound(error) {
  const seen = new Set();
  let current = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    const code = current?.code;
    const message = current instanceof Error
      ? current.message
      : typeof current === 'string'
        ? current
        : JSON.stringify(current);

    if (
      (code === -32001 && /session not found/iu.test(message ?? ''))
      || (/-32001/u.test(message ?? '') && /session not found/iu.test(message ?? ''))
    ) {
      return true;
    }
    current = current?.cause;
  }
  return false;
}

export class PtyUpstreamClient {
  constructor({
    url = process.env.PTY_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL,
    ClientImpl = Client,
    TransportImpl = StreamableHTTPClientTransport,
    diagnostics = terminalDiagnostics,
    logger = null,
    sleepImpl = delay,
    randomImpl = Math.random,
    reconnect = {},
  } = {}) {
    this.url = url;
    this.ClientImpl = ClientImpl;
    this.TransportImpl = TransportImpl;
    this.diagnostics = diagnostics;
    this.logger = logger;
    this.sleepImpl = sleepImpl;
    this.randomImpl = randomImpl;
    this.reconnect = validateReconnect(reconnect);
    this.client = null;
    this.transport = null;
    this.reconnectPromise = null;
    this.backoffLevel = 0;
    this.closed = false;
  }

  async log(level, event, data = {}) {
    try {
      await this.logger?.[level]?.(event, data);
    } catch {
      // Diagnostics must never become a transport failure domain.
    }
  }

  backoffDelay() {
    const exponential = Math.min(
      this.reconnect.maxDelayMs,
      this.reconnect.baseDelayMs * (2 ** this.backoffLevel),
    );
    const random = Math.min(1, Math.max(0, Number(this.randomImpl())));
    const factor = 1 + this.reconnect.jitterRatio * ((2 * random) - 1);
    return Math.max(0, Math.round(Math.min(this.reconnect.maxDelayMs, exponential * factor)));
  }

  resetBackoff() {
    this.backoffLevel = 0;
  }

  async invalidate() {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (client) await client.close?.().catch?.(() => {});
    else if (transport) await transport.close?.().catch?.(() => {});
  }

  async connectAttempt() {
    const client = new this.ClientImpl({
      name: 'persistent-terminal-extended-upstream',
      version: VERSION,
    });
    const transport = new this.TransportImpl(new URL(this.url));
    try {
      await client.connect(transport);
      return { client, transport };
    } catch (error) {
      await client.close?.().catch?.(() => {});
      await transport.close?.().catch?.(() => {});
      throw error;
    }
  }

  async reconnectLoop() {
    let lastError;
    for (let attempt = 1; attempt <= this.reconnect.maxAttempts; attempt += 1) {
      this.diagnostics?.recordReconnectAttempt?.();
      await this.log('info', 'upstream_reconnect_attempt', {
        attempt,
        max_attempts: this.reconnect.maxAttempts,
      });
      try {
        const connected = await this.connectAttempt();
        this.client = connected.client;
        this.transport = connected.transport;
        this.diagnostics?.recordReconnectSuccess?.();
        await this.log('info', 'upstream_reconnect_success', {
          attempt,
          max_attempts: this.reconnect.maxAttempts,
        });
        return this.client;
      } catch (error) {
        lastError = error;
        this.diagnostics?.recordReconnectFailure?.();
        this.diagnostics?.recordFailure?.('transport_reconnect_failure');
        await this.log('warn', 'upstream_reconnect_failure', {
          attempt,
          max_attempts: this.reconnect.maxAttempts,
          error,
        });
        if (attempt >= this.reconnect.maxAttempts) break;
        const waitMs = this.backoffDelay();
        this.backoffLevel = Math.min(this.backoffLevel + 1, 30);
        await this.sleepImpl(waitMs);
      }
    }
    throw reconnectError(lastError, this.reconnect.maxAttempts);
  }

  async connect() {
    if (this.closed) throw new TerminalError('transport_reconnect_failure', 'pty-mcp upstream client is closed');
    if (this.client) return this.client;
    if (this.reconnectPromise) return this.reconnectPromise;

    this.reconnectPromise = this.reconnectLoop();
    try {
      return await this.reconnectPromise;
    } finally {
      this.reconnectPromise = null;
    }
  }

  async listTools() {
    for (let functionalAttempt = 0; functionalAttempt < 2; functionalAttempt += 1) {
      const client = await this.connect();
      try {
        const result = await client.listTools();
        this.resetBackoff();
        return result;
      } catch (error) {
        this.diagnostics?.recordFailure?.('transport_reconnect_failure');
        await this.invalidate();
        if (functionalAttempt === 1) {
          throw new TerminalError(
            'transport_reconnect_failure',
            `pty-mcp tools/list failed after reconnect: ${error instanceof Error ? error.message : String(error)}`,
            { retryable: true, cause: error },
          );
        }
      }
    }
    throw new TerminalError('transport_reconnect_failure', 'pty-mcp tools/list reconnect failed', { retryable: true });
  }

  async callTool(name, args = {}) {
    const client = await this.connect();
    try {
      return await client.callTool({ name, arguments: args ?? {} });
    } catch (error) {
      this.diagnostics?.recordFailure?.('transport_reconnect_failure');
      const definiteStaleSession = isDefinitiveSessionNotFound(error);
      await this.invalidate();

      if (definiteStaleSession) {
        const retryClient = await this.connect();
        try {
          return await retryClient.callTool({ name, arguments: args ?? {} });
        } catch (retryError) {
          this.diagnostics?.recordFailure?.('transport_reconnect_failure');
          await this.invalidate();
          await this.connect().catch(() => {});
          throw new TerminalError(
            'transport_reconnect_failure',
            `pty-mcp tool call failed after one safe stale-session retry: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
            { retryable: true, cause: retryError },
          );
        }
      }

      // Do not replay an arbitrary tool call: the upstream may have performed
      // a side effect before its response was lost. Re-establish connectivity
      // for the next request, while preserving at-most-once behavior here.
      await this.connect().catch(() => {});
      throw new TerminalError(
        'transport_reconnect_failure',
        `pty-mcp tool call lost its transport and was not replayed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    }
  }

  getServerVersion() {
    return this.client?.getServerVersion?.() ?? null;
  }

  async close() {
    this.closed = true;
    const pending = this.reconnectPromise;
    this.reconnectPromise = null;
    if (pending) await pending.catch(() => {});
    await this.invalidate();
  }
}
