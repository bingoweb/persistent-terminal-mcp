import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_STATES,
  mapExitCodeToTaskState,
  transitionTask,
} from '../src/task-model.mjs';

function task(state = 'queued') {
  return Object.freeze({
    task_id: 'task_00112233445566778899aabb',
    target: 'taylan',
    command: 'sleep 1',
    state,
  });
}

test('task state vocabulary is closed and ordered around queued/running/terminal states', () => {
  assert.deepEqual([...TASK_STATES], [
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'lost',
  ]);
});

test('queued task can start, cancel before start, or become lost', () => {
  assert.equal(transitionTask(task('queued'), { type: 'started' }).state, 'running');
  assert.equal(transitionTask(task('queued'), { type: 'cancelled' }).state, 'cancelled');
  assert.equal(transitionTask(task('queued'), { type: 'lost' }).state, 'lost');
});

test('running task maps exit 0 to succeeded and non-zero exit to failed', () => {
  const succeeded = transitionTask(task('running'), { type: 'exited', exit_code: 0 });
  assert.equal(succeeded.state, 'succeeded');
  assert.equal(succeeded.exit_code, 0);

  const failed = transitionTask(task('running'), { type: 'exited', exit_code: 7 });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.exit_code, 7);
});

test('running task can be explicitly cancelled or marked lost', () => {
  assert.equal(transitionTask(task('running'), { type: 'cancelled' }).state, 'cancelled');
  assert.equal(transitionTask(task('running'), { type: 'lost' }).state, 'lost');
});

test('terminal exit mapping accepts only byte-sized shell exit status', () => {
  assert.equal(mapExitCodeToTaskState(0), 'succeeded');
  assert.equal(mapExitCodeToTaskState(1), 'failed');
  assert.equal(mapExitCodeToTaskState(255), 'failed');
  for (const value of [-1, 256, 1.5, '0', null]) {
    assert.throws(() => mapExitCodeToTaskState(value), /exit_code/u);
  }
});

test('backward or terminal-state transitions are rejected without mutating the input task', () => {
  const succeeded = task('succeeded');
  assert.throws(() => transitionTask(succeeded, { type: 'started' }), /transition/u);
  assert.throws(() => transitionTask(succeeded, { type: 'lost' }), /transition/u);
  assert.throws(() => transitionTask(task('failed'), { type: 'started' }), /transition/u);
  assert.throws(() => transitionTask(task('cancelled'), { type: 'exited', exit_code: 0 }), /transition/u);
  assert.throws(() => transitionTask(task('lost'), { type: 'started' }), /transition/u);
  assert.equal(succeeded.state, 'succeeded');
  assert.equal('exit_code' in succeeded, false);
});

test('invalid events and invalid source states are rejected before producing a new task', () => {
  assert.throws(() => transitionTask(task('queued'), { type: 'exited', exit_code: 0 }), /transition/u);
  assert.throws(() => transitionTask(task('running'), { type: 'started' }), /transition/u);
  assert.throws(() => transitionTask(task('running'), { type: 'unknown' }), /event/u);
  assert.throws(() => transitionTask({ ...task(), state: 'mystery' }, { type: 'started' }), /state/u);
});

test('transition returns a new frozen task while preserving unrelated metadata', () => {
  const original = Object.freeze({
    ...task('running'),
    marker: '__PTEXT_TASK_marker_',
    cursor: 123,
  });
  const next = transitionTask(original, { type: 'exited', exit_code: 0 });
  assert.notStrictEqual(next, original);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(next.marker, original.marker);
  assert.equal(next.cursor, 123);
  assert.equal(original.state, 'running');
});
