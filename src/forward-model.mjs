import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import { TerminalError } from './errors.mjs';

const FORWARD_TYPES = new Set(['local', 'remote', 'dynamic']);
const SAFE_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/u;
const SAFE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/u;

function validatePort(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TerminalError('validation_error', `${field} port must be an integer between 1 and 65535`);
  }
  return value;
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty string');
  }
  const normalized = value.trim();
  if (normalized.includes('\0') || /\s/u.test(normalized) || normalized.startsWith('-')) {
    throw new TerminalError('validation_error', 'target must be a safe OpenSSH host or alias');
  }
  return normalized;
}

function normalizeName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SAFE_NAME.test(value)) {
    throw new TerminalError(
      'validation_error',
      'name must use only letters, numbers, dot, underscore or hyphen and be at most 65 characters',
    );
  }
  return value;
}

function normalizeHost(value, field, { bind = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (bind) return '127.0.0.1';
    throw new TerminalError('validation_error', `${field} must be a non-empty host`);
  }
  if (typeof value !== 'string') {
    throw new TerminalError('validation_error', `${field} must be a string`);
  }
  let normalized = value.trim();
  if (normalized.includes('\0') || normalized === '') {
    throw new TerminalError('validation_error', `${field} must be a non-empty host`);
  }
  if (normalized === 'localhost') normalized = '127.0.0.1';
  if (bind && normalized === '*') normalized = '0.0.0.0';
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  if (isIP(normalized) !== 0) return normalized;
  if (!SAFE_HOSTNAME.test(normalized)) {
    throw new TerminalError('validation_error', `${field} must be a valid IP address or hostname`);
  }
  return normalized;
}

function formatForwardHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function generateForwardId(randomBytesImpl) {
  const bytes = randomBytesImpl(12);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 12) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'forward ID generator returned invalid entropy',
    );
  }
  return `fwd_${bytes.toString('hex')}`;
}

export function createForwardDefinition(
  input,
  {
    existingDefinitions = [],
    randomBytesImpl = randomBytes,
  } = {},
) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TerminalError('validation_error', 'forward definition must be an object');
  }
  if (!FORWARD_TYPES.has(input.type)) {
    throw new TerminalError('validation_error', 'forward type must be local, remote or dynamic');
  }

  const name = normalizeName(input.name);
  if (name !== null && existingDefinitions.some((definition) => definition?.name === name)) {
    throw new TerminalError('validation_error', `forward name already exists: ${name}`);
  }

  const target = normalizeTarget(input.target);
  const bindAddress = normalizeHost(input.bind_address, 'bind_address', { bind: true });
  const listenPort = validatePort(input.listen_port, 'listen_port');

  let destinationHost;
  let destinationPort;
  if (input.type === 'dynamic') {
    if (input.destination_host !== undefined || input.destination_port !== undefined) {
      throw new TerminalError(
        'validation_error',
        'dynamic forwards must not include destination fields',
      );
    }
  } else {
    destinationHost = normalizeHost(input.destination_host, 'destination_host');
    destinationPort = validatePort(input.destination_port, 'destination_port');
  }

  const definition = {
    forward_id: generateForwardId(randomBytesImpl),
    name,
    target,
    type: input.type,
    bind_address: bindAddress,
    listen_port: listenPort,
  };
  if (input.type !== 'dynamic') {
    definition.destination_host = destinationHost;
    definition.destination_port = destinationPort;
  }
  return Object.freeze(definition);
}

export function buildForwardSshArgs(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new TerminalError('validation_error', 'forward definition is required');
  }
  if (!FORWARD_TYPES.has(definition.type)) {
    throw new TerminalError('validation_error', 'forward definition has an invalid type');
  }

  const common = [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  const bind = formatForwardHost(definition.bind_address);
  let flag;
  let specification;

  if (definition.type === 'dynamic') {
    flag = '-D';
    specification = `${bind}:${definition.listen_port}`;
  } else {
    flag = definition.type === 'local' ? '-L' : '-R';
    const destination = formatForwardHost(definition.destination_host);
    specification = `${bind}:${definition.listen_port}:${destination}:${definition.destination_port}`;
  }
  return [...common, flag, specification, definition.target];
}
