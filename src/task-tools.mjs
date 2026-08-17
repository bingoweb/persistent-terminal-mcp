import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import {
  cancelTask,
  getTaskStatus,
  listTasks,
  readTaskOutput,
  startTask,
  waitForTask,
} from './task-manager.mjs';

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

const TASK_PUBLIC_PROPERTIES = Object.freeze({
  task_id: { type: 'string', minLength: 1 },
  target: { type: 'string', minLength: 1 },
  remote_session_id: { type: 'string', minLength: 1 },
  state: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'lost'] },
  started_at: { type: 'string', minLength: 1 },
  cursor: { type: 'integer', minimum: 0 },
  exit_code: { type: 'integer', minimum: 0, maximum: 255 },
});

const TASK_PUBLIC_REQUIRED = Object.freeze([
  'task_id',
  'target',
  'remote_session_id',
  'state',
  'started_at',
  'cursor',
]);

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function publicTaskSchema(extraProperties = {}, extraRequired = []) {
  return objectSchema(
    { ...TASK_PUBLIC_PROPERTIES, ...extraProperties },
    [...TASK_PUBLIC_REQUIRED, ...extraRequired],
  );
}

function outputSchema(success) {
  return { type: 'object', oneOf: [success, FAILURE_SCHEMA] };
}

export const TASK_TOOLS = Object.freeze([
  Object.freeze({
    name: 'task_start',
    description: 'Start a command in its own persistent remote PTY and return persistent task identity without terminal scrollback.',
    inputSchema: objectSchema({
      target: { type: 'string', minLength: 1 },
      command: { type: 'string', minLength: 1 },
    }, ['target', 'command']),
    outputSchema: outputSchema(publicTaskSchema()),
  }),
  Object.freeze({
    name: 'task_status',
    description: 'Return persisted task state and recover the local PTY handle from the recorded remote session when needed.',
    inputSchema: objectSchema({ task_id: { type: 'string', minLength: 1 } }, ['task_id']),
    outputSchema: outputSchema(publicTaskSchema()),
  }),
  Object.freeze({
    name: 'task_output',
    description: 'Read bounded incremental task output from the stored cursor and update task completion state from the anchored marker.',
    inputSchema: objectSchema({
      task_id: { type: 'string', minLength: 1 },
      max_bytes: { type: 'integer', minimum: 1, maximum: 262144, default: 32768 },
    }, ['task_id']),
    outputSchema: outputSchema(publicTaskSchema({
      output: { type: 'string' },
      has_more: { type: 'boolean' },
      is_truncated: { type: 'boolean' },
    }, ['output', 'has_more', 'is_truncated'])),
  }),
  Object.freeze({
    name: 'task_wait',
    description: 'Wait for the persistent task completion marker using one bounded upstream wait_for operation rather than rapid polling.',
    inputSchema: objectSchema({
      task_id: { type: 'string', minLength: 1 },
      timeout: { type: 'number', minimum: 0, maximum: 600, default: 30 },
    }, ['task_id']),
    outputSchema: outputSchema(publicTaskSchema({
      timed_out: { type: 'boolean' },
    }, ['timed_out'])),
  }),
  Object.freeze({
    name: 'task_cancel',
    description: 'Send Ctrl-C only to the recorded persistent task PTY and optionally terminate that dedicated session if bounded cancellation does not complete.',
    inputSchema: objectSchema({
      task_id: { type: 'string', minLength: 1 },
      timeout: { type: 'number', minimum: 0, maximum: 30, default: 5 },
      terminate_session: { type: 'boolean', default: false },
    }, ['task_id']),
    outputSchema: outputSchema(publicTaskSchema({
      terminated_session: { type: 'boolean' },
    }, ['terminated_session'])),
  }),
  Object.freeze({
    name: 'task_list',
    description: 'List persisted task lifecycle metadata without command text, completion markers, local session IDs or terminal scrollback.',
    inputSchema: objectSchema({}),
    outputSchema: outputSchema(objectSchema({
      tasks: { type: 'array', items: publicTaskSchema() },
    }, ['tasks'])),
  }),
]);

export const TASK_TOOL_NAMES = new Set(TASK_TOOLS.map((tool) => tool.name));

function result(value, { isError = false } = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) response.isError = true;
  return response;
}

function publicTask(task) {
  const value = {
    task_id: task.task_id,
    target: task.target,
    remote_session_id: task.remote_session_id,
    state: task.state,
    started_at: task.started_at,
    cursor: task.cursor,
  };
  if (Number.isInteger(task.exit_code)) value.exit_code = task.exit_code;
  return value;
}

function validateArgsObject(args, name) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TerminalError('validation_error', `${name} arguments must be an object`);
  }
}

const defaultTaskManager = Object.freeze({
  start: (args) => startTask(args),
  status: (taskId) => getTaskStatus(taskId),
  output: (taskId, options) => readTaskOutput(taskId, options),
  wait: (taskId, options) => waitForTask(taskId, options),
  cancel: (taskId, options) => cancelTask(taskId, options),
  list: () => listTasks(),
});

export async function callTaskTool(
  name,
  args = {},
  { taskManager = defaultTaskManager } = {},
) {
  try {
    if (!TASK_TOOL_NAMES.has(name)) {
      throw new TerminalError('validation_error', `Unknown task tool: ${name}`);
    }
    validateArgsObject(args, name);

    if (name === 'task_start') {
      return result(publicTask(await taskManager.start({ target: args.target, command: args.command })));
    }
    if (name === 'task_status') {
      return result(publicTask(await taskManager.status(args.task_id)));
    }
    if (name === 'task_output') {
      const read = await taskManager.output(args.task_id, {
        maxBytes: args.max_bytes ?? 32768,
      });
      return result({
        ...publicTask(read.task),
        output: read.output,
        cursor: read.cursor,
        has_more: read.has_more,
        is_truncated: read.is_truncated,
      });
    }
    if (name === 'task_wait') {
      const waited = await taskManager.wait(args.task_id, { timeout: args.timeout ?? 30 });
      return result({ ...publicTask(waited.task), timed_out: waited.timed_out });
    }
    if (name === 'task_cancel') {
      const cancelled = await taskManager.cancel(args.task_id, {
        timeout: args.timeout ?? 5,
        terminateSession: args.terminate_session ?? false,
      });
      return result({
        ...publicTask(cancelled.task),
        terminated_session: cancelled.terminated_session,
      });
    }
    if (Object.keys(args).length !== 0) {
      throw new TerminalError('validation_error', 'task_list does not accept arguments');
    }
    const tasks = await taskManager.list();
    return result({ tasks: tasks.map(publicTask) });
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}
