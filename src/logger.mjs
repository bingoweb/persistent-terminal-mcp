import fs from 'node:fs/promises';
import path from 'node:path';

import { redactValue } from './redaction.mjs';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;

function positiveInteger(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, field, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('logger now() returned an invalid date');
  return date.toISOString();
}

function serializedRecord(record, maxRecordBytes) {
  let line = JSON.stringify(record);
  if (Buffer.byteLength(line, 'utf8') + 1 <= maxRecordBytes) return `${line}\n`;

  const compact = {
    timestamp: record.timestamp,
    level: record.level,
    event: String(record.event).slice(0, 128),
    data: {
      truncated: true,
      original_bytes: Buffer.byteLength(line, 'utf8'),
    },
  };
  line = JSON.stringify(compact);

  if (Buffer.byteLength(line, 'utf8') + 1 > maxRecordBytes) {
    compact.event = 'truncated';
    delete compact.data.original_bytes;
    line = JSON.stringify(compact);
  }
  if (Buffer.byteLength(line, 'utf8') + 1 > maxRecordBytes) {
    throw new RangeError('maxRecordBytes is too small for a bounded JSONL record');
  }
  return `${line}\n`;
}

async function statSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function renameIfExists(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function rotate(filePath, maxFiles) {
  if (maxFiles === 0) {
    await removeIfExists(filePath);
    return;
  }

  await removeIfExists(`${filePath}.${maxFiles}`);
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    await renameIfExists(`${filePath}.${index}`, `${filePath}.${index + 1}`);
  }
  await renameIfExists(filePath, `${filePath}.1`);
}

export function createJsonlLogger({
  path: filePath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  now = () => new Date(),
  extraSecrets = [],
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('logger path must be a non-empty string');
  }
  const fileLimit = positiveInteger(maxBytes, 'maxBytes', DEFAULT_MAX_BYTES);
  const rotatedLimit = nonNegativeInteger(maxFiles, 'maxFiles', DEFAULT_MAX_FILES);
  const recordLimit = positiveInteger(
    maxRecordBytes,
    'maxRecordBytes',
    DEFAULT_MAX_RECORD_BYTES,
  );
  if (recordLimit > fileLimit) {
    throw new TypeError('maxRecordBytes must not exceed maxBytes');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let queue = Promise.resolve();
  let closed = false;

  function enqueue(operation) {
    if (closed) return Promise.reject(new Error('logger is closed'));
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  }

  async function write(level, event, data = {}) {
    return enqueue(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const record = redactValue({
        timestamp: timestamp(now),
        level: String(level),
        event: String(event),
        data,
      }, { extraSecrets });
      const line = serializedRecord(record, recordLimit);
      const lineBytes = Buffer.byteLength(line, 'utf8');
      const currentBytes = await statSize(filePath);

      if (currentBytes > 0 && currentBytes + lineBytes > fileLimit) {
        await rotate(filePath, rotatedLimit);
      }

      await fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
      await fs.chmod(filePath, 0o600);
    });
  }

  async function close() {
    closed = true;
    await queue;
  }

  return Object.freeze({
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    close,
  });
}

