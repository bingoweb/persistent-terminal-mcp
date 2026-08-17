import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import {
  ensureSession,
  forgetLocalSessionHandle,
  listNamedSessions,
} from './session-registry.mjs';
import { createStateStore } from './state-store.mjs';
import { PtyUpstreamClient } from './upstream-pty.mjs';

const defaultStateStore = createStateStore();
const defaultUpstreamClient = new PtyUpstreamClient();

const FAILURE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...ERROR_CATEGORIES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    details: {},
  },
  required: ['category', 'message', 'retryable'],
  additionalProperties: false,
});

function outputSchema(successSchema) {
  return {
    type: 'object',
    oneOf: [successSchema, FAILURE_SCHEMA],
  };
}

const ENSURE_SESSION_SUCCESS = Object.freeze({
  type: 'object',
  properties: {
    session_id: { type: 'string', minLength: 1 },
    remote_session_id: { type: 'string', minLength: 1 },
    reused: { type: 'boolean' },
    recovered: { type: 'boolean' },
  },
  required: ['session_id', 'remote_session_id', 'reused', 'recovered'],
  additionalProperties: false,
});

const SESSION_METADATA_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string' },
    target: { type: 'string' },
    cwd: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    local_session_id: { type: ['string', 'null'] },
    remote_session_id: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: [
    'name',
    'target',
    'cwd',
    'tags',
    'local_session_id',
    'remote_session_id',
    'created_at',
    'updated_at',
  ],
  additionalProperties: false,
});

export const SESSION_TOOLS = Object.freeze([
  Object.freeze({
    name: 'ensure_session',
    description: 'Ensure a named persistent SSH session exists, reusing or recovering its remote ai-tmux session when possible.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        target: { type: 'string', minLength: 1, description: 'Native OpenSSH host or alias.' },
        cwd: { type: 'string', minLength: 1 },
        tags: { type: 'array', items: { type: 'string' } },
        persistent: {
          type: 'boolean',
          default: true,
          description: 'Named sessions are persistent. false is rejected.',
        },
      },
      required: ['name', 'target'],
      additionalProperties: false,
    },
    outputSchema: outputSchema(ENSURE_SESSION_SUCCESS),
  }),
  Object.freeze({
    name: 'named_session_list',
    description: 'List persisted named-session metadata without terminal scrollback or secret material.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      type: 'object',
      properties: {
        sessions: { type: 'array', items: SESSION_METADATA_SCHEMA },
      },
      required: ['sessions'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'named_session_detach',
    description: 'Detach the local handle for a named persistent session while leaving the remote ai-tmux PTY alive.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        remote_session_id: { type: ['string', 'null'] },
        detached: { type: 'boolean' },
        already_detached: { type: 'boolean' },
      },
      required: ['name', 'remote_session_id', 'detached', 'already_detached'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'named_session_close',
    description: 'Close the attached PTY for a named session and remove its persisted mapping after upstream close succeeds.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        remote_session_id: { type: ['string', 'null'] },
        closed: { type: 'boolean' },
      },
      required: ['name', 'remote_session_id', 'closed'],
      additionalProperties: false,
    }),
  }),
]);

export const SESSION_TOOL_NAMES = new Set(SESSION_TOOLS.map((tool) => tool.name));

function toolResult(value, { isError = false } = {}) {
  const result = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) result.isError = true;
  return result;
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '' || name.includes('\0')) {
    throw new TerminalError('validation_error', 'Session name must be a non-empty string without NUL bytes');
  }
  return name;
}

function publicSessionMetadata(entry) {
  return {
    name: entry.name,
    target: entry.target,
    cwd: entry.cwd ?? null,
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    local_session_id: entry.local_session_id ?? null,
    remote_session_id: entry.remote_session_id ?? null,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

async function findNamedSession(name, { stateStore, listNamedSessionsImpl }) {
  const validatedName = validateName(name);
  const sessions = await listNamedSessionsImpl({ stateStore });
  const entry = sessions.find((item) => item.name === validatedName);
  if (!entry) {
    throw new TerminalError(
      'stale_session_task_forward_id',
      `Named session not found: ${validatedName}`,
    );
  }
  return entry;
}

async function removeNamedSession(name, stateStore) {
  await stateStore.update((state) => {
    delete state.sessions[name];
  });
}

function assertUpstreamSuccess(result, toolName) {
  if (result?.isError === true) {
    const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
    throw new TerminalError(
      'local_capability_dependency_error',
      `${toolName} failed${typeof text === 'string' && text.length > 0 ? `: ${text}` : ''}`,
    );
  }
}

export async function callSessionTool(
  name,
  args = {},
  {
    stateStore = defaultStateStore,
    upstreamClient = defaultUpstreamClient,
    ensureSessionImpl = ensureSession,
    listNamedSessionsImpl = listNamedSessions,
    forgetLocalSessionHandleImpl = forgetLocalSessionHandle,
    now = () => new Date().toISOString(),
  } = {},
) {
  try {
    if (name === 'ensure_session') {
      if (args?.persistent === false) {
        throw new TerminalError('validation_error', 'ensure_session only supports persistent named sessions');
      }
      const { persistent: _persistent, ...sessionArgs } = args ?? {};
      const result = await ensureSessionImpl(sessionArgs, { stateStore, upstreamClient, now });
      return toolResult(result);
    }

    if (name === 'named_session_list') {
      const sessions = await listNamedSessionsImpl({ stateStore });
      return toolResult({ sessions: sessions.map(publicSessionMetadata) });
    }

    if (name === 'named_session_detach') {
      const entry = await findNamedSession(args?.name, { stateStore, listNamedSessionsImpl });
      if (!entry.local_session_id) {
        return toolResult({
          name: entry.name,
          remote_session_id: entry.remote_session_id ?? null,
          detached: true,
          already_detached: true,
        });
      }

      const upstreamResult = await upstreamClient.callTool('detach_session', {
        session_id: entry.local_session_id,
      });
      assertUpstreamSuccess(upstreamResult, 'detach_session');
      await forgetLocalSessionHandleImpl(entry.local_session_id, { stateStore, now });
      return toolResult({
        name: entry.name,
        remote_session_id: entry.remote_session_id ?? null,
        detached: true,
        already_detached: false,
      });
    }

    if (name === 'named_session_close') {
      const entry = await findNamedSession(args?.name, { stateStore, listNamedSessionsImpl });
      if (!entry.local_session_id) {
        throw new TerminalError(
          'stale_session_task_forward_id',
          `Named session ${entry.name} is detached; call ensure_session before closing it`,
        );
      }

      const upstreamResult = await upstreamClient.callTool('close_session', {
        session_id: entry.local_session_id,
      });
      assertUpstreamSuccess(upstreamResult, 'close_session');
      await removeNamedSession(entry.name, stateStore);
      return toolResult({
        name: entry.name,
        remote_session_id: entry.remote_session_id ?? null,
        closed: true,
      });
    }

    throw new TerminalError('validation_error', `Unknown session tool: ${name}`);
  } catch (error) {
    return toolResult(normalizeFailure(error), { isError: true });
  }
}
