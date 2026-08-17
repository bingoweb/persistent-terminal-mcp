import { TerminalError, normalizeFailure } from './errors.mjs';
import { FORWARD_TOOLS, FORWARD_TOOL_NAMES, callForwardTool } from './forward-tools.mjs';
import { TERMINAL_HEALTH_TOOL, callTerminalHealthTool } from './health-tool.mjs';
import { buildLegacyAliasTools, resolveLegacyAliasCall } from './legacy-aliases.mjs';
import { remoteExec } from './remote-exec.mjs';
import { REMOTE_FS_TOOLS, REMOTE_FS_TOOL_NAMES, callRemoteFsTool } from './remote-fs-tools.mjs';
import { remoteRootExec } from './root-exec.mjs';
import { SESSION_TOOLS, SESSION_TOOL_NAMES, callSessionTool } from './session-tools.mjs';
import { SYSTEM_TOOLS, SYSTEM_TOOL_NAMES, callSystemTool } from './system-tools.mjs';
import { TASK_TOOLS, TASK_TOOL_NAMES, callTaskTool } from './task-tools.mjs';
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

export const ROOT_EXEC_TOOL = Object.freeze({
  name: 'remote_root_exec',
  description: 'Execute an explicitly privileged command as UID 0 on an allowlisted remote target using best-effort root acquisition. The provider may use an already-root SSH user, passwordless sudo, Docker host-root, or a secret-safe interactive password gate. This is never an implicit fallback from remote_exec.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        minLength: 1,
        description: 'Explicitly allowlisted native OpenSSH host or alias.',
      },
      command: {
        type: 'string',
        minLength: 1,
        description: 'Command to execute as UID 0 after an explicit root provider succeeds.',
      },
      timeout_ms: { type: 'integer', minimum: 1 },
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
          strategy: {
            type: 'string',
            enum: [
              'direct_root',
              'sudo_nopasswd',
              'docker_host_root',
              'sudo_password',
              'su_root_password',
            ],
            description: 'Explicit privileged execution strategy used for this call.',
          },
          target: { type: 'string' },
          exit_code: { type: ['integer', 'null'] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          duration_ms: { type: 'number' },
          timed_out: { type: 'boolean' },
          truncated: { type: 'boolean' },
          attempts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                strategy: {
                  type: 'string',
                  enum: [
                    'direct_root',
                    'sudo_nopasswd',
                    'docker_host_root',
                    'sudo_password',
                    'su_root_password',
                  ],
                },
                status: { type: 'string', enum: ['selected', 'unavailable'] },
              },
              required: ['strategy', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: [
          'strategy',
          'target',
          'exit_code',
          'stdout',
          'stderr',
          'duration_ms',
          'timed_out',
          'truncated',
          'attempts',
        ],
        additionalProperties: false,
      },
      REMOTE_EXEC_TOOL.outputSchema.oneOf[1],
    ],
  },
});

export const LOCAL_TOOLS = Object.freeze([
  REMOTE_EXEC_TOOL,
  ROOT_EXEC_TOOL,
  ...SESSION_TOOLS,
  ...REMOTE_FS_TOOLS,
  ...TRANSFER_TOOLS,
  ...FORWARD_TOOLS,
  ...TASK_TOOLS,
  ...SYSTEM_TOOLS,
  TERMINAL_HEALTH_TOOL,
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
    rootExecImpl = remoteRootExec,
    sessionToolCallImpl = callSessionTool,
    remoteFsToolCallImpl = callRemoteFsTool,
    transferToolCallImpl = callTransferTool,
    forwardToolCallImpl = callForwardTool,
    taskToolCallImpl = callTaskTool,
    systemToolCallImpl = callSystemTool,
    healthToolCallImpl = callTerminalHealthTool,
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

  if (name === ROOT_EXEC_TOOL.name) {
    try {
      const result = await rootExecImpl(args ?? {}, { upstreamClient });
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

  if (TASK_TOOL_NAMES.has(name)) {
    return taskToolCallImpl(name, args ?? {});
  }

  if (SYSTEM_TOOL_NAMES.has(name)) {
    return systemToolCallImpl(name, args ?? {}, { upstreamClient });
  }

  if (name === TERMINAL_HEALTH_TOOL.name) {
    return healthToolCallImpl(args ?? {}, { upstreamClient });
  }

  const legacy = resolveLegacyAliasCall(name, args ?? {});
  if (legacy) {
    return callTool(legacy.target, legacy.args, {
      upstreamClient,
      upstreamToolNames,
      remoteExecImpl,
      rootExecImpl,
      sessionToolCallImpl,
      remoteFsToolCallImpl,
      transferToolCallImpl,
      forwardToolCallImpl,
      taskToolCallImpl,
      systemToolCallImpl,
      healthToolCallImpl,
    });
  }

  if (!upstreamToolNames?.has(name)) {
    throw new TerminalError('validation_error', `Unknown tool: ${name}`);
  }

  // Return the upstream object verbatim. In particular, secret tools must not
  // be inspected, logged or re-serialized by the extension layer.
  return upstreamClient.callTool(name, args ?? {});
}
