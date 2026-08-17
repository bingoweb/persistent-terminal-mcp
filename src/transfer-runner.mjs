import { spawn } from 'node:child_process';

import { TerminalError } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_LOG_TAIL_BYTES = 8192;

function boundedTail(current, chunk, maxBytes) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  if (next.length <= maxBytes) return next;
  return next.subarray(next.length - maxBytes);
}

function parseNumber(value) {
  const normalized = value.replace(/,/gu, '');
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseRsyncProgress(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { bytesTransferred: 0, bytesTotal: 0 };
  }

  const pattern = /([\d,]+)\s+(\d{1,3})%/gu;
  let latest = null;
  for (const match of text.matchAll(pattern)) latest = match;
  if (!latest) return { bytesTransferred: 0, bytesTotal: 0 };

  const bytesTransferred = parseNumber(latest[1]);
  const percent = Number.parseInt(latest[2], 10);
  const bytesTotal = percent > 0
    ? Math.max(bytesTransferred, Math.round((bytesTransferred * 100) / percent))
    : 0;
  return { bytesTransferred, bytesTotal };
}

export function parseRsyncStats(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { filesTransferred: 0, bytesTransferred: 0 };
  }
  const filesMatch = text.match(/Number of regular files transferred:\s*([\d,]+)/u);
  const bytesMatch = text.match(/Total transferred file size:\s*([\d,]+)\s+bytes/u);
  return {
    filesTransferred: filesMatch ? parseNumber(filesMatch[1]) : 0,
    bytesTransferred: bytesMatch ? parseNumber(bytesMatch[1]) : 0,
  };
}

export async function runTransferProcess(
  executable,
  args,
  {
    spawnImpl = spawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxLogTailBytes = DEFAULT_LOG_TAIL_BYTES,
  } = {},
) {
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new TerminalError('validation_error', 'transfer executable must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TerminalError('validation_error', 'transfer argv must contain only NUL-free strings');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TerminalError('validation_error', 'transfer timeout must be a positive integer');
  }

  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let timer = null;

    let child;
    try {
      child = spawnImpl(executable, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
    } catch (error) {
      reject(new TerminalError(
        'local_capability_dependency_error',
        `failed to start transfer executable ${executable}`,
        { cause: error, details: { executable } },
      ));
      return;
    }

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    child.stdout?.on('data', (chunk) => {
      stdoutTail = boundedTail(stdoutTail, chunk, maxLogTailBytes);
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail = boundedTail(stderrTail, chunk, maxLogTailBytes);
    });
    child.once('error', (error) => {
      finish(() => reject(new TerminalError(
        'local_capability_dependency_error',
        `transfer executable failed to start: ${executable}`,
        { cause: error, details: { executable, code: error?.code } },
      )));
    });
    child.once('close', (code, signal) => {
      finish(() => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const stdout = stdoutTail.toString('utf8');
        const stderr = stderrTail.toString('utf8');
        if (timedOut) {
          reject(new TerminalError(
            'timeout',
            'transfer process timed out',
            { retryable: true, details: { executable, timeout_ms: timeoutMs } },
          ));
          return;
        }
        if (code !== 0) {
          reject(new TerminalError(
            'remote_command_nonzero_exit',
            `transfer process exited with status ${code ?? 'null'}`,
            {
              details: {
                executable,
                exit_code: code,
                signal,
                stderr_tail: stderr,
              },
            },
          ));
          return;
        }
        const combined = `${stdout}\n${stderr}`;
        const progress = parseRsyncProgress(combined);
        const stats = parseRsyncStats(combined);
        resolve({
          exitCode: code,
          durationMs,
          bytesTransferred: stats.bytesTransferred || progress.bytesTransferred,
          bytesTotal: progress.bytesTotal,
          filesTransferred: stats.filesTransferred,
          resumed: false,
        });
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();
  });
}
