import { Action, ActionReducer, combineReducers } from '@ngrx/store';
import { DEFAULT_TASK, Task, TaskState } from '../../features/tasks/task.model';
import {
  initialTaskState,
  TASK_FEATURE_NAME,
  taskReducer,
} from '../../features/tasks/store/task.reducer';
import {
  TASK_TIME_BUFFER_FEATURE_KEY,
  TaskTimeBuffer,
  taskTimeBufferReducer,
} from '../../features/tasks/store/task-time-buffer.reducer';
import { unsetCurrentTask } from '../../features/tasks/store/task.actions';
import {
  initialTimeTrackingState,
  TIME_TRACKING_FEATURE_KEY,
  timeTrackingReducer,
} from '../../features/time-tracking/store/time-tracking.reducer';
import { TimeTrackingActions } from '../../features/time-tracking/store/time-tracking.actions';
import { TimeTrackingState } from '../../features/time-tracking/time-tracking.model';
import { roundTsToMinutes } from '../../util/round-ts-to-minutes';
import { taskTimeBufferMetaReducer } from './task-time-buffer.meta-reducer';

const DAY = '2026-01-05';

interface TestState {
  [TASK_FEATURE_NAME]: TaskState;
  [TIME_TRACKING_FEATURE_KEY]: TimeTrackingState;
  [TASK_TIME_BUFFER_FEATURE_KEY]: TaskTimeBuffer | null;
}

describe('taskTimeBufferMetaReducer', () => {
  const task: Task = {
    ...DEFAULT_TASK,
    id: 'task-1',
    title: 'task-1',
    projectId: 'project-1',
    timeSpentOnDay: { [DAY]: 60000 },
    timeSpent: 60000,
  };
  const otherTask: Task = { ...task, id: 'task-2', title: 'task-2' };

  const innerReducer = combineReducers({
    [TASK_FEATURE_NAME]: taskReducer,
    [TIME_TRACKING_FEATURE_KEY]: timeTrackingReducer,
    [TASK_TIME_BUFFER_FEATURE_KEY]: taskTimeBufferReducer,
  }) as unknown as ActionReducer<TestState, Action>;
  const reducer = taskTimeBufferMetaReducer(innerReducer) as ActionReducer<
    TestState,
    Action
  >;

  const createState = (buffer: TaskTimeBuffer | null = null): TestState => ({
    [TASK_FEATURE_NAME]: {
      ...initialTaskState,
      ids: [task.id, otherTask.id],
      entities: { [task.id]: task, [otherTask.id]: otherTask },
      currentTaskId: task.id,
    },
    [TIME_TRACKING_FEATURE_KEY]: initialTimeTrackingState,
    [TASK_TIME_BUFFER_FEATURE_KEY]: buffer,
  });

  const bufferTick = (
    taskId = task.id,
    date = DAY,
  ): ReturnType<typeof TimeTrackingActions.bufferTimeSpent> =>
    TimeTrackingActions.bufferTimeSpent({ taskId, date, duration: 1000 });

  const addTick = (t = task): ReturnType<typeof TimeTrackingActions.addTimeSpent> =>
    TimeTrackingActions.addTimeSpent({
      task: t,
      date: DAY,
      duration: 1000,
      isFromTrackingReminder: false,
    });

  const timeSpentOf = (state: TestState, id = task.id): number =>
    state[TASK_FEATURE_NAME].entities[id]!.timeSpent;

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(2026, 0, 5, 10, 0, 0));
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it('keeps buffered ticks out of the task and the work stamps', () => {
    let state = createState();
    state = reducer(state, bufferTick());
    state = reducer(state, bufferTick());
    state = reducer(state, bufferTick());

    expect(timeSpentOf(state)).toBe(60000);
    expect(state[TIME_TRACKING_FEATURE_KEY]).toBe(initialTimeTrackingState);
    expect(state[TASK_TIME_BUFFER_FEATURE_KEY]).toEqual({
      taskId: task.id,
      date: DAY,
      duration: 3000,
    });
  });

  it('adds the buffer to its task before any other action reduces', () => {
    let seenTimeSpent: number | undefined;
    const probingReducer = taskTimeBufferMetaReducer(
      (state: TestState | undefined, action: Action) => {
        if (action.type === unsetCurrentTask.type) {
          seenTimeSpent = timeSpentOf(state!);
        }
        return innerReducer(state, action);
      },
    );

    const state = probingReducer(
      createState({ taskId: task.id, date: DAY, duration: 3000 }),
      unsetCurrentTask(),
    ) as TestState;

    expect(seenTimeSpent).toBe(63000);
    expect(timeSpentOf(state)).toBe(63000);
    expect(state[TASK_FEATURE_NAME].entities[task.id]!.timeSpentOnDay).toEqual({
      [DAY]: 63000,
    });
    expect(state[TASK_FEATURE_NAME].currentTaskId).toBeNull();
    expect(state[TASK_TIME_BUFFER_FEATURE_KEY]).toBeNull();
  });

  it('stamps the work start and end for the buffered time', () => {
    const state = reducer(
      createState({ taskId: task.id, date: DAY, duration: 3000 }),
      unsetCurrentTask(),
    );

    const now = roundTsToMinutes(Date.now());
    expect(state[TIME_TRACKING_FEATURE_KEY].project['project-1'][DAY]).toEqual(
      jasmine.objectContaining({ s: now, e: now }),
    );
    expect(state[TIME_TRACKING_FEATURE_KEY].tag['TODAY'][DAY]).toEqual(
      jasmine.objectContaining({ s: now, e: now }),
    );
  });

  it('adds a buffer for another task or day before buffering the new tick', () => {
    const forOtherTask = reducer(
      createState({ taskId: task.id, date: DAY, duration: 3000 }),
      bufferTick(otherTask.id),
    );
    expect(timeSpentOf(forOtherTask)).toBe(63000);
    expect(timeSpentOf(forOtherTask, otherTask.id)).toBe(60000);
    expect(forOtherTask[TASK_TIME_BUFFER_FEATURE_KEY]).toEqual({
      taskId: otherTask.id,
      date: DAY,
      duration: 1000,
    });

    const forNextDay = reducer(
      createState({ taskId: task.id, date: DAY, duration: 3000 }),
      bufferTick(task.id, '2026-01-06'),
    );
    expect(forNextDay[TASK_FEATURE_NAME].entities[task.id]!.timeSpentOnDay).toEqual({
      [DAY]: 63000,
    });
    expect(forNextDay[TASK_TIME_BUFFER_FEATURE_KEY]).toEqual({
      taskId: task.id,
      date: '2026-01-06',
      duration: 1000,
    });
  });

  it('drops a buffer whose task is gone', () => {
    const state = createState({ taskId: 'gone', date: DAY, duration: 3000 });

    const result = reducer(state, unsetCurrentTask());

    expect(result[TASK_TIME_BUFFER_FEATURE_KEY]).toBeNull();
    expect(timeSpentOf(result)).toBe(60000);
    expect(result[TIME_TRACKING_FEATURE_KEY]).toBe(initialTimeTrackingState);
  });

  it('passes actions through untouched without a buffer', () => {
    const state = createState();

    expect(reducer(state, { type: 'UNRELATED' })).toBe(state);
  });

  it('ends in the same state as adding every tick straight away', () => {
    let direct = createState();
    for (let i = 0; i < 5; i++) {
      direct = reducer(direct, addTick(direct[TASK_FEATURE_NAME].entities[task.id]!));
    }
    direct = reducer(direct, unsetCurrentTask());

    let buffered = createState();
    buffered = reducer(buffered, addTick());
    for (let i = 0; i < 4; i++) {
      buffered = reducer(buffered, bufferTick());
    }
    buffered = reducer(buffered, unsetCurrentTask());

    expect(buffered).toEqual(direct);
  });
});
