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

import * as focusActions from '../../features/focus-mode/store/focus-mode.actions';
import {
  focusModeReducer,
  initialState as initialFocusState,
} from '../../features/focus-mode/store/focus-mode.reducer';
import {
  FocusModeMode,
  FocusModeState,
} from '../../features/focus-mode/focus-mode.model';

const DAY = '2026-01-05';
const TICK_AT = new Date(2026, 0, 5, 10, 0, 0).getTime();
const STAMPS = { firstTickAt: TICK_AT, lastTickAt: TICK_AT };

interface TestState {
  focusMode: FocusModeState;
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
    focusMode: focusModeReducer,
    [TASK_FEATURE_NAME]: taskReducer,
    [TIME_TRACKING_FEATURE_KEY]: timeTrackingReducer,
    [TASK_TIME_BUFFER_FEATURE_KEY]: taskTimeBufferReducer,
  }) as unknown as ActionReducer<TestState, Action>;
  const reducer = taskTimeBufferMetaReducer(innerReducer) as ActionReducer<
    TestState,
    Action
  >;

  const createState = (buffer: TaskTimeBuffer | null = null): TestState => ({
    focusMode: initialFocusState,
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
      ...STAMPS,
      taskId: task.id,
      date: DAY,
      duration: 3000,
    });
  });

  for (const mode of [FocusModeMode.Pomodoro, FocusModeMode.Flowtime]) {
    it(`keeps task time buffered while the ${mode} display timer ticks`, () => {
      let state = reducer(createState(), focusActions.setFocusModeMode({ mode }));
      state = reducer(state, focusActions.startFocusSession({ duration: 25000 }));
      const tasks = state.tasks;
      const stamps = state.timeTracking;
      for (let i = 0; i < 20; i++) {
        jasmine.clock().tick(1000);
        state = reducer(state, bufferTick());
        state = reducer(state, focusActions.tick());
      }
      expect(state.tasks).toBe(tasks);
      expect(state.timeTracking).toBe(stamps);
      expect(state.taskTimeBuffer?.duration).toBe(20000);
      expect(state.focusMode.timer.elapsed).toBe(20000);
      // A semantic transition still exposes every buffered second immediately.
      state = reducer(state, focusActions.pauseFocusSession({}));
      expect(timeSpentOf(state)).toBe(80000);
      expect(state.taskTimeBuffer).toBeNull();
    });
  }

  it('flushes on focus completion after the final display tick', () => {
    let state = reducer(
      createState(),
      focusActions.setFocusModeMode({ mode: FocusModeMode.Pomodoro }),
    );
    state = reducer(state, focusActions.startFocusSession({ duration: 1000 }));
    jasmine.clock().tick(1000);
    state = reducer(state, bufferTick());
    state = reducer(state, focusActions.tick());
    expect(state.focusMode.timer.isRunning).toBeFalse();
    expect(state.taskTimeBuffer?.duration).toBe(1000);
    state = reducer(state, focusActions.completeFocusSession({ isManual: false }));
    expect(timeSpentOf(state)).toBe(61000);
    expect(state.taskTimeBuffer).toBeNull();
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
      createState({ ...STAMPS, taskId: task.id, date: DAY, duration: 3000 }),
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
    jasmine.clock().mockDate(new Date(2026, 0, 6, 10, 0, 0));
    const state = reducer(
      createState({
        ...STAMPS,
        lastTickAt: TICK_AT + 31000,
        taskId: task.id,
        date: DAY,
        duration: 3000,
      }),
      unsetCurrentTask(),
    );

    const start = roundTsToMinutes(TICK_AT);
    const end = roundTsToMinutes(TICK_AT + 31000);
    expect(state[TIME_TRACKING_FEATURE_KEY].project['project-1'][DAY]).toEqual(
      jasmine.objectContaining({ s: start, e: end }),
    );
    expect(state[TIME_TRACKING_FEATURE_KEY].tag['TODAY'][DAY]).toEqual(
      jasmine.objectContaining({ s: start, e: end }),
    );
  });

  it('adds a buffer for another task or day before buffering the new tick', () => {
    const forOtherTask = reducer(
      createState({ ...STAMPS, taskId: task.id, date: DAY, duration: 3000 }),
      bufferTick(otherTask.id),
    );
    expect(timeSpentOf(forOtherTask)).toBe(63000);
    expect(timeSpentOf(forOtherTask, otherTask.id)).toBe(60000);
    expect(forOtherTask[TASK_TIME_BUFFER_FEATURE_KEY]).toEqual({
      ...STAMPS,
      taskId: otherTask.id,
      date: DAY,
      duration: 1000,
    });

    const forNextDay = reducer(
      createState({ ...STAMPS, taskId: task.id, date: DAY, duration: 3000 }),
      bufferTick(task.id, '2026-01-06'),
    );
    expect(forNextDay[TASK_FEATURE_NAME].entities[task.id]!.timeSpentOnDay).toEqual({
      [DAY]: 63000,
    });
    expect(forNextDay[TASK_TIME_BUFFER_FEATURE_KEY]).toEqual({
      ...STAMPS,
      taskId: task.id,
      date: '2026-01-06',
      duration: 1000,
    });
  });

  it('drops a buffer whose task is gone', () => {
    const state = createState({ ...STAMPS, taskId: 'gone', date: DAY, duration: 3000 });

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
