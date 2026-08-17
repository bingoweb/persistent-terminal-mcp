import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createLocalhostMcpGuard,
  validateLocalRequest,
} from '../src/localhost-http-guard.mjs';

test('localhost request validation accepts local Host and absent or local Origin only', () => {
  assert.deepEqual(validateLocalRequest({ host: '127.0.0.1:9031' }), { ok: true });
  assert.deepEqual(validateLocalRequest({ host: 'localhost:9031', origin: 'http://localhost:6274' }), { ok: true });
  assert.deepEqual(validateLocalRequest({ host: '[::1]:9031', origin: 'http://[::1]:6274' }), { ok: true });

  assert.equal(validateLocalRequest({ host: 'evil.example.com', origin: 'http://evil.example.com' }).ok, false);
  assert.equal(validateLocalRequest({ host: '127.0.0.1:9031', origin: 'http://evil.example.com' }).ok, false);
  assert.equal(validateLocalRequest({ host: 'evillocalhost:9031' }).ok, false);
  assert.equal(validateLocalRequest({ host: '127.0.0.1.evil.example:9031' }).ok, false);
  assert.equal(validateLocalRequest({}).ok, false);
});

test('guard rejects non-local Host/Origin before backend and transparently streams valid requests/responses', async (t) => {
  let backendHits = 0;
  const backend = http.createServer((req, res) => {
    backendHits += 1;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'mcp-session-id': 'guard-test-session',
    });
    req.pipe(res);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = backend.address().port;

  const guard = createLocalhostMcpGuard({
    backendHost: '127.0.0.1',
    backendPort,
  });
  guard.listen(0, '127.0.0.1');
  await once(guard, 'listening');
  const guardPort = guard.address().port;

  t.after(async () => {
    guard.close();
    backend.close();
    await Promise.allSettled([once(guard, 'close'), once(backend, 'close')]);
  });

  const rejected = await fetch(`http://127.0.0.1:${guardPort}/mcp`, {
    method: 'POST',
    headers: {
      host: 'evil.example.com',
      origin: 'http://evil.example.com',
      'content-type': 'application/json',
    },
    body: '{"jsonrpc":"2.0"}',
  });
  assert.equal(rejected.status >= 400 && rejected.status < 500, true);
  assert.equal(backendHits, 0);

  const payload = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const accepted = await fetch(`http://127.0.0.1:${guardPort}/mcp`, {
    method: 'POST',
    headers: {
      origin: `http://localhost:${guardPort}`,
      'content-type': 'application/json',
    },
    body: payload,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('mcp-session-id'), 'guard-test-session');
  assert.equal(await accepted.text(), payload);
  assert.equal(backendHits, 1);
});
