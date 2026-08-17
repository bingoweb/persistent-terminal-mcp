import { TerminalError } from './errors.mjs';

export const TASK_STATES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'lost',
]);

const STATE_SET = new Set(TASK_STATES);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'lost']);

export function mapExitCodeToTaskState(exitCode) {
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new TerminalError(
      'validation_error',
      'exit_code must be an integer between 0 and 255',
    );
  }
  return exitCode === 0 ? 'succeeded' : 'failed';
}

function validateTask(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    throw new TerminalError('validation_error', 'task must be an object');
  }
  if (!STATE_SET.has(task.state)) {
    throw new TerminalError('validation_error', `invalid task state: ${String(task.state)}`);
  }
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new TerminalError('validation_error', 'task event must be an object');
  }
  if (!['started', 'exited', 'cancelled', 'lost'].includes(event.type)) {
    throw new TerminalError('validation_error', `invalid task event: ${String(event.type)}`);
  }
}

function transitionError(from, eventType) {
  return new TerminalError(
    'validation_error',
    `invalid task transition: ${from} -> ${eventType}`,
    { details: { state: from, event: eventType } },
  );
}

export function transitionTask(task, event) {
  validateTask(task);
  validateEvent(event);

  if (TERMINAL_STATES.has(task.state)) {
    throw transitionError(task.state, event.type);
  }

  let nextState;
  let exitCode;
  if (task.state === 'queued') {
    if (event.type === 'started') nextState = 'running';
    else if (event.type === 'cancelled') nextState = 'cancelled';
    else if (event.type === 'lost') nextState = 'lost';
    else throw transitionError(task.state, event.type);
  } else if (task.state === 'running') {
    if (event.type === 'exited') {
      exitCode = event.exit_code;
      nextState = mapExitCodeToTaskState(exitCode);
    } else if (event.type === 'cancelled') nextState = 'cancelled';
    else if (event.type === 'lost') nextState = 'lost';
    else throw transitionError(task.state, event.type);
  } else {
    throw transitionError(task.state, event.type);
  }

  const next = {
    ...task,
    state: nextState,
  };
  if (event.type === 'exited') next.exit_code = exitCode;
  return Object.freeze(next);
}
