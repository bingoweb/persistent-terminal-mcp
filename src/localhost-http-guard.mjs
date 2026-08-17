import http from 'node:http';
import { pathToFileURL } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function validPort(value) {
  if (value === undefined) return true;
  if (!/^\d{1,5}$/u.test(value)) return false;
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535;
}

function hostNameFromHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\s,@/\\]/u.test(value)) return null;

  if (value.startsWith('[')) {
    const match = value.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/u);
    if (!match || !validPort(match[2])) return null;
    return match[1].toLowerCase();
  }

  const match = value.match(/^([^:]+)(?::(\d{1,5}))?$/u);
  if (!match || !validPort(match[2])) return null;
  return match[1].toLowerCase();
}

function localOrigin(value) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return false;

  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1).toLowerCase()
    : parsed.hostname.toLowerCase();
  return LOCAL_HOSTS.has(hostname);
}

export function validateLocalRequest({ host, origin } = {}) {
  const hostname = hostNameFromHeader(host);
  if (!hostname || !LOCAL_HOSTS.has(hostname)) {
    return { ok: false, reason: 'invalid_host' };
  }
  if (!localOrigin(origin)) {
    return { ok: false, reason: 'invalid_origin' };
  }
  return { ok: true };
}

function copyHeaders(headers, { backendHost, backendPort } = {}) {
  const copied = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    copied[name] = value;
  }
  if (backendHost !== undefined) copied.host = `${backendHost}:${backendPort}`;
  return copied;
}

export function createLocalhostMcpGuard({
  backendHost = '127.0.0.1',
  backendPort = 9032,
  agent = new http.Agent({ keepAlive: true, maxSockets: 64 }),
} = {}) {
  if (backendHost !== '127.0.0.1' && backendHost !== 'localhost' && backendHost !== '::1') {
    throw new TypeError('localhost MCP guard backend must be localhost-class');
  }
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
    throw new TypeError('localhost MCP guard backendPort must be an integer from 1 to 65535');
  }

  const server = http.createServer((req, res) => {
    const validation = validateLocalRequest({
      host: req.headers.host,
      origin: req.headers.origin,
    });
    if (!validation.ok) {
      res.writeHead(403, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'forbidden_local_request', reason: validation.reason }));
      return;
    }

    const upstream = http.request({
      host: backendHost,
      port: backendPort,
      method: req.method,
      path: req.url,
      headers: copyHeaders(req.headers, { backendHost, backendPort }),
      agent,
    }, (upstreamResponse) => {
      res.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        copyHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(res);
    });

    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'mcp_backend_unavailable' }));
      } else {
        res.destroy();
      }
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  server.on('close', () => agent.destroy());
  return server;
}

function parsePort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== raw) {
    throw new TypeError(`${name} must be an integer from 1 to 65535`);
  }
  return parsed;
}

async function main() {
  const listenHost = process.env.PTEXT_GUARD_HOST ?? '127.0.0.1';
  if (listenHost !== '127.0.0.1' && listenHost !== 'localhost' && listenHost !== '::1') {
    throw new TypeError('PTEXT_GUARD_HOST must be localhost-class');
  }
  const listenPort = parsePort('PTEXT_GUARD_PORT', 9031);
  const backendHost = process.env.PTEXT_GUARD_BACKEND_HOST ?? '127.0.0.1';
  const backendPort = parsePort('PTEXT_GUARD_BACKEND_PORT', 9032);
  const server = createLocalhostMcpGuard({ backendHost, backendPort });

  server.listen(listenPort, listenHost);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  process.stderr.write(`persistent-terminal localhost guard listening on ${listenHost}:${listenPort} -> ${backendHost}:${backendPort}\n`);

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`persistent-terminal localhost guard failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
