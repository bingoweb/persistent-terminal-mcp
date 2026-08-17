import { randomBytes } from 'node:crypto';

import { isRootTargetAllowed } from './config.mjs';
import { TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';
import { quotePosix } from './ssh-runner.mjs';
import { resolveTarget } from './target-resolver.mjs';

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 32_768;
const STRATEGIES = Object.freeze({
  DIRECT: 'direct_root',
  SUDO_NOPASSWD: 'sudo_nopasswd',
  DOCKER: 'docker_host_root',
  SUDO_PASSWORD: 'sudo_password',
  SU_PASSWORD: 'su_root_password',
});

function validateRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TerminalError('validation_error', 'remote_root_exec request must be an object');
  }
  if (typeof request.target !== 'string' || request.target.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty string');
  }
  if (request.target.includes('\0')) {
    throw new TerminalError('validation_error', 'target must not contain NUL bytes');
  }
  if (typeof request.command !== 'string' || request.command.trim() === '') {
    throw new TerminalError('validation_error', 'command must be a non-empty string');
  }
  if (request.command.includes('\0')) {
    throw new TerminalError('validation_error', 'command must not contain NUL bytes');
  }
  if (request.timeout_ms !== undefined && (!Number.isInteger(request.timeout_ms) || request.timeout_ms < 1)) {
    throw new TerminalError('validation_error', 'timeout_ms must be a positive integer');
  }
  if (
    request.max_output_bytes !== undefined
    && (!Number.isInteger(request.max_output_bytes) || request.max_output_bytes < 1)
  ) {
    throw new TerminalError('validation_error', 'max_output_bytes must be a positive integer');
  }
}

function tokenDefault() {
  return randomBytes(12).toString('hex');
}

function executionRequest(request, target, command) {
  return {
    target,
    command,
    ...(request.timeout_ms !== undefined ? { timeout_ms: request.timeout_ms } : {}),
    ...(request.max_output_bytes !== undefined ? { max_output_bytes: request.max_output_bytes } : {}),
  };
}

function resultFromExecution(strategy, target, executed, attempts) {
  return {
    strategy,
    target,
    exit_code: executed.exit_code,
    stdout: executed.stdout ?? '',
    stderr: executed.stderr ?? '',
    duration_ms: executed.duration_ms ?? 0,
    timed_out: Boolean(executed.timed_out),
    truncated: Boolean(executed.truncated),
    attempts,
  };
}

function attempt(attempts, strategy, status) {
  attempts.push({ strategy, status });
}

function dockerHostRootCommand(command) {
  return [
    'docker run',
    '--rm',
    '--privileged',
    '--pid=host',
    '--net=host',
    '-v /:/host',
    'ubuntu:26.04',
    'chroot /host',
    '/bin/bash -lc',
    quotePosix(command),
  ].join(' ');
}

function sudoNoPasswordCommand(command) {
  return `sudo -n -- /bin/bash -lc ${quotePosix(command)}`;
}

function parseToolJson(result) {
  if (result?.isError === true) {
    const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
    throw new TerminalError(
      'permission_privilege_error',
      text || 'Upstream secret/session operation failed',
    );
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') return result ?? {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function capability(remoteExecImpl, target, command) {
  return remoteExecImpl({
    target,
    command,
    timeout_ms: PROBE_TIMEOUT_MS,
    max_output_bytes: PROBE_OUTPUT_BYTES,
  });
}

function buildRootWrapper(command, token) {
  const start = `__PTEXT_ROOT_START_${token}__`;
  const end = `__PTEXT_ROOT_END_${token}__`;
  return {
    start,
    end,
    source: [
      `printf '\\n${start}\\n'`,
      `( ${command} )`,
      '__ptext_code=$?',
      `printf '\\n${end}%s\\n' "$__ptext_code"`,
      'exit 0',
    ].join('; '),
  };
}

function extractInteractiveResult(output, wrapper, token) {
  const outer = `__PTEXT_ROOT_OUTER_${token}__`;
  const startIndex = output.indexOf(`${wrapper.start}\n`);
  const endRegex = new RegExp(`\\n${wrapper.end}(\\d{1,3})(?:\\r?\\n|$)`, 'u');
  const endMatch = endRegex.exec(output);
  const outerRegex = new RegExp(`${outer}(\\d{1,3})`, 'u');
  const outerMatch = outerRegex.exec(output);

  if (startIndex < 0 || !endMatch) {
    return {
      providerSucceeded: false,
      providerExitCode: outerMatch ? Number.parseInt(outerMatch[1], 10) : null,
      commandExitCode: null,
      output: '',
    };
  }

  const contentStart = startIndex + wrapper.start.length + 1;
  const contentEnd = endMatch.index;
  return {
    providerSucceeded: true,
    providerExitCode: outerMatch ? Number.parseInt(outerMatch[1], 10) : 0,
    commandExitCode: Number.parseInt(endMatch[1], 10),
    output: output.slice(contentStart, contentEnd).replace(/^\r?\n/u, ''),
  };
}

async function collectSessionOutput(upstreamClient, sessionId, startCursor, maxBytes) {
  let cursor = startCursor;
  let combined = '';
  let truncated = false;

  while (Buffer.byteLength(combined, 'utf8') < maxBytes) {
    const remaining = maxBytes - Buffer.byteLength(combined, 'utf8');
    const read = parseToolJson(await upstreamClient.callTool('read_output', {
      session_id: sessionId,
      since_cursor: cursor,
      max_bytes: Math.min(READ_CHUNK_BYTES, remaining),
    }));
    combined += read.output ?? '';
    cursor = read.cursor ?? cursor;
    truncated ||= Boolean(read.is_truncated);
    if (!read.has_more) break;
  }

  return {
    output: combined,
    truncated: truncated || Buffer.byteLength(combined, 'utf8') >= maxBytes,
  };
}

async function interactivePasswordProvider({
  strategy,
  target,
  request,
  upstreamClient,
  resolveTargetImpl,
  randomTokenImpl,
  commandBuilder,
  promptText,
  promptPattern,
}) {
  if (!upstreamClient?.callTool) return { available: false, reason: 'secret_channel_unavailable' };

  const resolved = await resolveTargetImpl(target);
  if (!resolved?.user) return { available: false, reason: 'target_user_unresolved' };

  const token = randomTokenImpl();
  const effectivePromptPattern = typeof promptPattern === 'function'
    ? promptPattern(token)
    : promptPattern;
  const wrapper = buildRootWrapper(request.command, token);
  const outer = `__PTEXT_ROOT_OUTER_${token}__`;
  const shellCommand = commandBuilder(wrapper.source, token, outer);
  const timeoutSeconds = Math.max(1, Math.ceil((request.timeout_ms ?? DEFAULT_TIMEOUT_MS) / 1000));
  let sessionId = null;
  const startedAt = Date.now();

  try {
    const created = parseToolJson(await upstreamClient.callTool('create_ssh_session', {
      host: resolved.alias ?? target,
      user: resolved.user,
      persistent: false,
      command: '/bin/bash',
    }));
    sessionId = created.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { available: false, reason: 'interactive_session_unavailable' };
    }

    const initialState = parseToolJson(await upstreamClient.callTool('get_session_state', {
      session_id: sessionId,
    }));
    const startCursor = Number.isInteger(initialState.cursor) ? initialState.cursor : 0;

    await upstreamClient.callTool('send_input', {
      session_id: sessionId,
      input: shellCommand,
      timeout_ms: 1000,
    });

    const firstWait = parseToolJson(await upstreamClient.callTool('read_output', {
      session_id: sessionId,
      wait_for: `${effectivePromptPattern}|${outer}[0-9]{1,3}`,
      timeout: Math.min(timeoutSeconds, 10),
      tail_lines: 20,
    }));

    const firstLine = firstWait.match_line ?? '';
    if (firstLine.includes(outer)) {
      const collected = await collectSessionOutput(
        upstreamClient,
        sessionId,
        startCursor,
        request.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      );
      const parsed = extractInteractiveResult(collected.output, wrapper, token);
      if (!parsed.providerSucceeded) return { available: false, reason: `${strategy}_denied` };
      return {
        available: true,
        executed: {
          exit_code: parsed.commandExitCode,
          stdout: parsed.output,
          stderr: '',
          duration_ms: Date.now() - startedAt,
          timed_out: false,
          truncated: collected.truncated,
        },
      };
    }

    const promptState = parseToolJson(await upstreamClient.callTool('get_session_state', {
      session_id: sessionId,
    }));
    if (promptState.awaiting_secret !== true && promptState.state !== 'password_prompt') {
      return { available: false, reason: 'password_prompt_not_confirmed' };
    }

    parseToolJson(await upstreamClient.callTool('send_secret', {
      session_id: sessionId,
      prompt: promptText,
    }));

    const completion = parseToolJson(await upstreamClient.callTool('read_output', {
      session_id: sessionId,
      wait_for: `${outer}[0-9]{1,3}`,
      timeout: timeoutSeconds,
      tail_lines: 40,
    }));
    if (completion.matched !== true && !String(completion.match_line ?? '').includes(outer)) {
      return { available: false, reason: `${strategy}_timeout` };
    }

    const collected = await collectSessionOutput(
      upstreamClient,
      sessionId,
      startCursor,
      request.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );
    const parsed = extractInteractiveResult(collected.output, wrapper, token);
    if (!parsed.providerSucceeded) return { available: false, reason: `${strategy}_denied` };

    return {
      available: true,
      executed: {
        exit_code: parsed.commandExitCode,
        stdout: parsed.output,
        stderr: '',
        duration_ms: Date.now() - startedAt,
        timed_out: false,
        truncated: collected.truncated,
      },
    };
  } finally {
    if (sessionId) {
      await upstreamClient.callTool('close_session', { session_id: sessionId }).catch(() => {});
    }
  }
}

export async function remoteRootExec(
  request,
  {
    env = process.env,
    remoteExecImpl = remoteExec,
    upstreamClient,
    resolveTargetImpl = resolveTarget,
    randomTokenImpl = tokenDefault,
  } = {},
) {
  validateRequest(request);
  const target = request.target.trim();
  const attempts = [];

  if (!isRootTargetAllowed(target, env)) {
    throw new TerminalError(
      'permission_privilege_error',
      `Root execution is not enabled by PTEXT_ROOT_TARGETS for target: ${target}`,
      { details: { target, attempts } },
    );
  }

  const directProbe = await capability(remoteExecImpl, target, 'id -u');
  if (directProbe.timed_out) {
    throw new TerminalError('timeout', `Root identity probe timed out for target: ${target}`, {
      retryable: true,
      details: { target, attempts },
    });
  }
  if (directProbe.exit_code === 0 && directProbe.stdout.trim() === '0') {
    attempt(attempts, STRATEGIES.DIRECT, 'selected');
    const executed = await remoteExecImpl(executionRequest(request, target, request.command));
    return resultFromExecution(STRATEGIES.DIRECT, target, executed, attempts);
  }
  attempt(attempts, STRATEGIES.DIRECT, 'unavailable');

  const sudoProbe = await capability(remoteExecImpl, target, 'command -v sudo >/dev/null 2>&1');
  const sudoAvailable = sudoProbe.exit_code === 0 && !sudoProbe.timed_out;
  if (sudoAvailable) {
    const sudoNopasswd = await capability(remoteExecImpl, target, 'sudo -n -- /bin/bash -lc true');
    if (sudoNopasswd.exit_code === 0 && !sudoNopasswd.timed_out) {
      attempt(attempts, STRATEGIES.SUDO_NOPASSWD, 'selected');
      const executed = await remoteExecImpl(executionRequest(
        request,
        target,
        sudoNoPasswordCommand(request.command),
      ));
      return resultFromExecution(STRATEGIES.SUDO_NOPASSWD, target, executed, attempts);
    }
  }
  attempt(attempts, STRATEGIES.SUDO_NOPASSWD, 'unavailable');

  const dockerProbe = await capability(remoteExecImpl, target, 'command -v docker >/dev/null 2>&1');
  if (dockerProbe.exit_code === 0 && !dockerProbe.timed_out) {
    const dockerRootProof = await capability(remoteExecImpl, target, dockerHostRootCommand('id -u'));
    if (dockerRootProof.exit_code === 0 && dockerRootProof.stdout.trim() === '0' && !dockerRootProof.timed_out) {
      attempt(attempts, STRATEGIES.DOCKER, 'selected');
      const executed = await remoteExecImpl(executionRequest(
        request,
        target,
        dockerHostRootCommand(request.command),
      ));
      return resultFromExecution(STRATEGIES.DOCKER, target, executed, attempts);
    }
  }
  attempt(attempts, STRATEGIES.DOCKER, 'unavailable');

  if (sudoAvailable) {
    const sudoPassword = await interactivePasswordProvider({
      strategy: STRATEGIES.SUDO_PASSWORD,
      target,
      request,
      upstreamClient,
      resolveTargetImpl,
      randomTokenImpl,
      promptText: `Enter sudo password for ${target}:`,
      promptPattern: (token) => `__PTEXT_ROOT_PASSWORD_${token}__`,
      commandBuilder: (rootSource, token, outer) => {
        const prompt = `__PTEXT_ROOT_PASSWORD_${token}__`;
        return `sudo -S -p ${quotePosix(prompt)} -- /bin/bash -lc ${quotePosix(rootSource)}; __ptext_outer=$?; printf '\\n${outer}%s\\n' "$__ptext_outer"`;
      },
    });
    if (sudoPassword.available) {
      attempt(attempts, STRATEGIES.SUDO_PASSWORD, 'selected');
      return resultFromExecution(STRATEGIES.SUDO_PASSWORD, target, sudoPassword.executed, attempts);
    }
    attempt(attempts, STRATEGIES.SUDO_PASSWORD, 'unavailable');
  }

  const suProbe = await capability(remoteExecImpl, target, 'command -v su >/dev/null 2>&1');
  if (suProbe.exit_code === 0 && !suProbe.timed_out) {
    const suPassword = await interactivePasswordProvider({
      strategy: STRATEGIES.SU_PASSWORD,
      target,
      request,
      upstreamClient,
      resolveTargetImpl,
      randomTokenImpl,
      promptText: `Enter root password for ${target}:`,
      promptPattern: 'Password:',
      commandBuilder: (rootSource, _token, outer) => `LC_ALL=C su - root -c ${quotePosix(`/bin/bash -lc ${quotePosix(rootSource)}`)}; __ptext_outer=$?; printf '\\n${outer}%s\\n' "$__ptext_outer"`,
    });
    if (suPassword.available) {
      attempt(attempts, STRATEGIES.SU_PASSWORD, 'selected');
      return resultFromExecution(STRATEGIES.SU_PASSWORD, target, suPassword.executed, attempts);
    }
    attempt(attempts, STRATEGIES.SU_PASSWORD, 'unavailable');
  }

  throw new TerminalError(
    'permission_privilege_error',
    `Unable to obtain root access on root-policy-enabled target: ${target}`,
    { details: { target, attempts } },
  );
}
