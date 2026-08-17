import { TerminalError, normalizeFailure } from './errors.mjs';
import { FORWARD_TOOLS, FORWARD_TOOL_NAMES, callForwardTool } from './forward-tools.mjs';
import { buildLegacyAliasTools, resolveLegacyAliasCall } from './legacy-aliases.mjs';
import { remoteExec } from './remote-exec.mjs';
import { REMOTE_FS_TOOLS, REMOTE_FS_TOOL_NAMES, callRemoteFsTool } from './remote-fs-tools.mjs';
import { SESSION_TOOLS, SESSION_TOOL_NAMES, callSessionTool } from './session-tools.mjs';
import { TRANSFER_TOOLS, TRANSFER_TOOL_NAMES, callTransferTool } from './transfer-tools.mjs';

export const REMOTE_EXEC_TOOL = Object.freeze({
  name: 'remote_exec',
  description: 'Execute a bounded non-interactive command on a remote OpenSSH target and return structured stdout, stderr, exit status, timeout and truncation state.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', minLength: 1, description: 'Native OpenSSH host or alias, for example staging-box.' },
      command: { type: 'string', minLength: 1 },
      cwd: { type: 'string', minLength: 1 },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      timeout_ms: { type: 'integer', minimum: 1 },
      stdin: { type: 'string' },
      max_output_bytes: { type: 'integer', minimum: 1 },
    },
    required: ['target', 'command'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: {
          exit_code: { type: ['integer', 'null'] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          duration_ms: { type: 'number' },
          timed_out: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
        required: ['exit_code', 'stdout', 'stderr', 'duration_ms', 'timed_out', 'truncated'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [
              'validation_error',
              'target_resolution_error',
              'host_key_authentication_error',
              'transport_reconnect_failure',
              'timeout',
              'remote_command_nonzero_exit',
              'missing_remote_capability',
              'local_capability_dependency_error',
              'stale_session_task_forward_id',
              'permission_privilege_error',
              'checksum_integrity_failure',
              'binary_file',
            ],
          },
          message: { type: 'string' },
          retryable: { type: 'boolean' },
          details: {},
        },
        required: ['category', 'message', 'retryable'],
        additionalProperties: false,
      },
    ],
  },
});

export const LOCAL_TOOLS = Object.freeze([
  REMOTE_EXEC_TOOL,
  ...SESSION_TOOLS,
  ...REMOTE_FS_TOOLS,
  ...TRANSFER_TOOLS,
  ...FORWARD_TOOLS,
]);

export function buildToolCatalog({ upstreamTools = [], localTools = LOCAL_TOOLS } = {}) {
  const names = new Set();
  const catalog = [];

  for (const tool of upstreamTools) {
    if (!tool?.name || typeof tool.name !== 'string') {
      throw new TerminalError('validation_error', 'Upstream tool is missing a valid name');
    }
    if (names.has(tool.name)) {
      throw new TerminalError('validation_error', `Tool collision: ${tool.name}`);
    }
    names.add(tool.name);
    catalog.push(tool);
  }

  for (const tool of localTools) {
    if (names.has(tool.name)) {
      throw new TerminalError('validation_error', `Tool collision: ${tool.name}`);
    }
    names.add(tool.name);
    catalog.push(tool);
  }

  for (const tool of buildLegacyAliasTools(catalog)) {
    if (names.has(tool.name)) {
      throw new TerminalError('validation_error', `Tool collision: ${tool.name}`);
    }
    names.add(tool.name);
    catalog.push(tool);
  }

  return catalog;
}

export async function callTool(
  name,
  args,
  {
    upstreamClient,
    upstreamToolNames,
    remoteExecImpl = remoteExec,
    sessionToolCallImpl = callSessionTool,
    remoteFsToolCallImpl = callRemoteFsTool,
    transferToolCallImpl = callTransferTool,
    forwardToolCallImpl = callForwardTool,
  },
) {
  if (name === REMOTE_EXEC_TOOL.name) {
    try {
      const result = await remoteExecImpl(args ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const failure = normalizeFailure(error);
      return {
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        structuredContent: failure,
        isError: true,
      };
    }
  }

  if (SESSION_TOOL_NAMES.has(name)) {
    return sessionToolCallImpl(name, args ?? {}, { upstreamClient });
  }

  if (REMOTE_FS_TOOL_NAMES.has(name)) {
    return remoteFsToolCallImpl(name, args ?? {});
  }

  if (TRANSFER_TOOL_NAMES.has(name)) {
    return transferToolCallImpl(name, args ?? {});
  }

  if (FORWARD_TOOL_NAMES.has(name)) {
    return forwardToolCallImpl(name, args ?? {});
  }

  const legacy = resolveLegacyAliasCall(name, args ?? {});
  if (legacy) {
    return callTool(legacy.target, legacy.args, {
      upstreamClient,
      upstreamToolNames,
      remoteExecImpl,
      sessionToolCallImpl,
      remoteFsToolCallImpl,
      transferToolCallImpl,
      forwardToolCallImpl,
    });
  }

  if (!upstreamToolNames?.has(name)) {
    throw new TerminalError('validation_error', `Unknown tool: ${name}`);
  }

  // Return the upstream object verbatim. In particular, secret tools must not
  // be inspected, logged or re-serialized by the extension layer.
  return upstreamClient.callTool(name, args ?? {});
}
