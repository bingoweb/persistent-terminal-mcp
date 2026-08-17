import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { TerminalError } from './errors.mjs';

const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:9021/mcp';

export class PtyUpstreamClient {
  constructor({
    url = process.env.PTY_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL,
    ClientImpl = Client,
    TransportImpl = StreamableHTTPClientTransport,
  } = {}) {
    this.url = url;
    this.ClientImpl = ClientImpl;
    this.TransportImpl = TransportImpl;
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      const client = new this.ClientImpl({
        name: 'persistent-terminal-extended-upstream',
        version: '0.1.0',
      });
      const transport = new this.TransportImpl(new URL(this.url));

      try {
        await client.connect(transport);
      } catch (error) {
        await transport.close?.().catch?.(() => {});
        throw new TerminalError(
          'transport_reconnect_failure',
          `Unable to connect to pty-mcp upstream: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: true, cause: error },
        );
      }

      this.client = client;
      this.transport = transport;
      return client;
    })();

    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async listTools() {
    const client = await this.connect();
    return client.listTools();
  }

  async callTool(name, args = {}) {
    const client = await this.connect();
    return client.callTool({ name, arguments: args ?? {} });
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
    if (client) await client.close();
  }
}
