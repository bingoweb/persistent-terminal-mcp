import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDiagnostics } from '../src/diagnostics.mjs';
import { createJsonlLogger } from '../src/logger.mjs';

test('diagnostics keeps bounded reconnect/failure counters and no payload data', () => {
  const diagnostics = createDiagnostics({ counterMax: 3, failureCategoryLimit: 2 });
  for (let index = 0; index < 4; index += 1) diagnostics.recordReconnectAttempt();
  diagnostics.recordReconnectSuccess();
  diagnostics.recordReconnectFailure();
  diagnostics.recordFailure('transport_reconnect_failure');
  diagnostics.recordFailure('timeout');
  diagnostics.recordFailure('permission_privilege_error');
  diagnostics.recordFailure('transport_reconnect_failure');
  diagnostics.recordFailure({ category: 'TEST_SECRET_CATEGORY_VALUE' });

  const snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot, {
    reconnect: { attempts: 3, successes: 1, failures: 1 },
    failures: {
      total: 3,
      by_category: {
        transport_reconnect_failure: 2,
        timeout: 1,
        other: 2,
      },
    },
  });
  assert.equal(JSON.stringify(snapshot).includes('TEST_SECRET_CATEGORY_VALUE'), false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.reconnect), true);
  assert.equal(Object.isFrozen(snapshot.failures.by_category), true);
});

test('diagnostics reset clears counters without changing public shape', () => {
  const diagnostics = createDiagnostics();
  diagnostics.recordReconnectAttempt();
  diagnostics.recordFailure('timeout');
  diagnostics.reset();
  assert.deepEqual(diagnostics.snapshot(), {
    reconnect: { attempts: 0, successes: 0, failures: 0 },
    failures: { total: 0, by_category: {} },
  });
});

test('JSONL logger redacts payload before serialization', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptext-log-'));
  const logPath = path.join(dir, 'terminal.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logger = createJsonlLogger({
    path: logPath,
    now: () => new Date('2026-08-17T06:30:00.000Z'),
  });

  await logger.info('secret-test', {
    password: 'TEST_LOG_PASSWORD',
    header: 'Authorization: Bearer TEST_LOG_TOKEN',
    prepared_secret: 'TEST_BUFFERED_SECRET',
    visible: 'ok',
  });
  await logger.close();

  const text = await fs.readFile(logPath, 'utf8');
  const line = JSON.parse(text.trim());
  assert.equal(line.timestamp, '2026-08-17T06:30:00.000Z');
  assert.equal(line.level, 'info');
  assert.equal(line.event, 'secret-test');
  assert.equal(line.data.visible, 'ok');
  for (const secret of ['TEST_LOG_PASSWORD', 'TEST_LOG_TOKEN', 'TEST_BUFFERED_SECRET']) {
    assert.equal(text.includes(secret), false, `fixture leaked: ${secret}`);
  }
});

test('JSONL logger rotates at configured size and retains at most three rotated files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptext-rotate-'));
  const logPath = path.join(dir, 'terminal.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let tick = 0;
  const logger = createJsonlLogger({
    path: logPath,
    maxBytes: 220,
    maxFiles: 3,
    maxRecordBytes: 180,
    now: () => new Date(1_700_000_000_000 + tick++ * 1000),
  });

  for (let index = 0; index < 12; index += 1) {
    await logger.info('rotate', { index, message: 'x'.repeat(70) });
  }
  await logger.close();

  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, ['terminal.jsonl', 'terminal.jsonl.1', 'terminal.jsonl.2', 'terminal.jsonl.3']);
  for (const name of names) {
    const stat = await fs.stat(path.join(dir, name));
    assert.ok(stat.size <= 220, `${name} exceeded limit: ${stat.size}`);
  }
});

test('logger serializes concurrent writes and bounds oversized records', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptext-concurrent-log-'));
  const logPath = path.join(dir, 'terminal.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logger = createJsonlLogger({
    path: logPath,
    maxBytes: 4096,
    maxFiles: 1,
    maxRecordBytes: 320,
  });

  await Promise.all(Array.from({ length: 20 }, (_, index) => logger.info('concurrent', {
    index,
    huge: 'y'.repeat(10_000),
  })));
  await logger.close();

  const files = (await fs.readdir(dir)).filter((name) => name.startsWith('terminal.jsonl'));
  const lines = [];
  for (const name of files) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    lines.push(...text.trim().split('\n').filter(Boolean));
  }
  assert.ok(lines.length > 0);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.event, 'concurrent');
    assert.equal(parsed.data.truncated, true);
    assert.ok(Buffer.byteLength(line, 'utf8') <= 320);
  }
});
