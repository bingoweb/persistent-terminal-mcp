import { spawn } from 'node:child_process';

import { TerminalError } from './errors.mjs';

const WANTED_KEYS = new Set([
  'hostname',
  'user',
  'port',
  'identityfile',
  'proxyjump',
  'stricthostkeychecking',
]);

function validateAlias(alias) {
  if (typeof alias !== 'string' || alias.trim() === '') {
    throw new TerminalError('validation_error', 'Target alias must be a non-empty string');
  }
  if (alias.includes('\0')) {
    throw new TerminalError('validation_error', 'Target alias must not contain NUL bytes');
  }
  return alias;
}

function parseSshConfig(text) {
  const firstValues = new Map();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const splitAt = trimmed.search(/\s/);
    if (splitAt < 1) continue;

    const key = trimmed.slice(0, splitAt).toLowerCase();
    if (!WANTED_KEYS.has(key) || firstValues.has(key)) continue;

    firstValues.set(key, trimmed.slice(splitAt).trim());
  }

  return firstValues;
}

function collectProcess(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function resolveTarget(alias, { spawnImpl = spawn } = {}) {
  const validatedAlias = validateAlias(alias);

  let child;
  try {
    child = spawnImpl('ssh', ['-G', validatedAlias], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `Unable to start OpenSSH: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let completed;
  try {
    completed = await collectProcess(child);
  } catch (error) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `OpenSSH target resolution could not run: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (completed.code !== 0) {
    const diagnostic = completed.stderr.trim() || `ssh -G exited with code ${completed.code}`;
    throw new TerminalError('target_resolution_error', diagnostic, {
      details: { alias: validatedAlias, exit_code: completed.code, signal: completed.signal },
    });
  }

  const values = parseSshConfig(completed.stdout);
  const portText = values.get('port') ?? '22';
  const port = Number.parseInt(portText, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TerminalError('target_resolution_error', `Invalid OpenSSH port for ${validatedAlias}: ${portText}`);
  }

  return {
    alias: validatedAlias,
    host: validatedAlias,
    hostname: values.get('hostname') ?? validatedAlias,
    user: values.get('user') ?? null,
    port,
    identityFile: values.get('identityfile') ?? null,
    proxyJump: values.get('proxyjump') ?? null,
    strictHostKeyChecking: values.get('stricthostkeychecking') ?? null,
  };
}
