import { TestBed } from '@angular/core/testing';
import { Action, provideStore, Store } from '@ngrx/store';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { IS_ELECTRON_TOKEN } from '../../app.constants';
import { AppStateSnapshot } from '../../op-log/core/types/backup.types';
import { taskTimeBufferMetaReducer } from '../../root-store/meta/task-time-buffer.meta-reducer';
import {
  syncTimeSpent,
  TimeTrackingActions,
} from '../time-tracking/store/time-tracking.actions';
import {
  initialTimeTrackingState,
  TIME_TRACKING_FEATURE_KEY,
  timeTrackingReducer,
} from '../time-tracking/store/time-tracking.reducer';
import { initialTaskState, TASK_FEATURE_NAME, taskReducer } from './store/task.reducer';
import {
  TASK_TIME_BUFFER_FEATURE_KEY,
  taskTimeBufferReducer,
} from './store/task-time-buffer.reducer';
import { DEFAULT_TASK, Task, TaskState } from './task.model';
import { TaskTimeSyncService } from './task-time-sync.service';

const createTask = (id: string, overrides: Partial<Task> = {}): Task =>
  ({
    ...DEFAULT_TASK,
    id,
    title: id,
    created: 1,
    ...overrides,
  }) as Task;

describe('TaskTimeSyncService', () => {
  let service: TaskTimeSyncService;
  let store: MockStore;
  let dispatchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [TaskTimeSyncService, provideMockStore()],
    });
    service = TestBed.inject(TaskTimeSyncService);
    store = TestBed.inject(MockStore);
    dispatchSpy = spyOn(store, 'dispatch');
  });

  it('flushes accumulated time as a delta-only persistent action', () => {
    service.accumulate('task-1', 3000, '2024-01-15');
    service.accumulate('task-1', 2000, '2024-01-15');

    service.flush();

    const action = dispatchSpy.calls.mostRecent().args[0] as Record<string, unknown>;
    expect(action['type']).toBe('[TimeTracking] Sync time spent');
    expect(action['taskId']).toBe('task-1');
    expect(action['date']).toBe('2024-01-15');
    expect(action['duration']).toBe(5000);
    expect(action['timeSpentForDay']).toBeUndefined();
  });

  it('projects pending task time out of an op-log snapshot', () => {
    const task = createTask('task-1', {
      timeSpentOnDay: { ['2024-01-15']: 5000 },
      timeSpent: 5000,
    });
    const taskState: TaskState = {
      ...initialTaskState,
      ids: ['task-1'],
      entities: { ['task-1']: task },
    };
    const snapshot = { task: taskState } as AppStateSnapshot;
    service.accumulate('task-1', 5000, '2024-01-15');

    const projected = service.projectSnapshot(snapshot);

    expect((projected.task as TaskState).entities['task-1']!.timeSpent).toBe(0);
    expect((snapshot.task as TaskState).entities['task-1']!.timeSpent).toBe(5000);
  });

  it('reconstructs the live total from a projected snapshot plus the flushed tail op', () => {
    const task = createTask('task-1', {
      timeSpentOnDay: { ['2024-01-15']: 5000 },
      timeSpent: 5000,
    });
    const taskState: TaskState = {
      ...initialTaskState,
      ids: ['task-1'],
      entities: { ['task-1']: task },
    };
    service.accumulate('task-1', 5000, '2024-01-15');
    const projected = service.projectSnapshot({ task: taskState } as AppStateSnapshot);

    service.flush();
    const tailAction = dispatchSpy.calls.mostRecent().args[0];
    const replayedState = taskReducer(projected.task as TaskState, {
      ...tailAction,
      meta: { ...tailAction.meta, isRemote: true },
    });

    expect(replayedState.entities['task-1']!.timeSpentOnDay['2024-01-15']).toBe(5000);
    expect(replayedState.entities['task-1']!.timeSpent).toBe(5000);
  });

  it('returns the original snapshot when no task time is pending', () => {
    const snapshot = { task: initialTaskState } as AppStateSnapshot;

    expect(service.projectSnapshot(snapshot)).toBe(snapshot);
  });
});

describe('TaskTimeSyncService.addTick', () => {
  const DAY = '2026-01-05';
  let service: TaskTimeSyncService;
  let store: Store<{ [TASK_FEATURE_NAME]: TaskState }>;
  let dispatched: Action[];

  const setup = (isElectron: boolean, tasks: Task[]): void => {
    TestBed.configureTestingModule({
      providers: [
        provideStore(
          {
            [TASK_FEATURE_NAME]: taskReducer,
            [TIME_TRACKING_FEATURE_KEY]: timeTrackingReducer,
            [TASK_TIME_BUFFER_FEATURE_KEY]: taskTimeBufferReducer,
          },
          {
            metaReducers: [taskTimeBufferMetaReducer],
            initialState: {
              [TASK_FEATURE_NAME]: {
                ...initialTaskState,
                ids: tasks.map((t) => t.id),
                entities: Object.fromEntries(tasks.map((t) => [t.id, t])),
              },
              [TIME_TRACKING_FEATURE_KEY]: initialTimeTrackingState,
              [TASK_TIME_BUFFER_FEATURE_KEY]: null,
            },
          },
        ),
        { provide: IS_ELECTRON_TOKEN, useValue: isElectron },
      ],
    });
    service = TestBed.inject(TaskTimeSyncService);
    store = TestBed.inject(Store);
    dispatched = [];
    const dispatch = store.dispatch.bind(store);
    spyOn(store, 'dispatch').and.callFake(((action: Action) => {
      dispatched.push(action);
      dispatch(action);
    }) as typeof store.dispatch);
  };

  const storedTask = (id = 'task-1'): Task =>
    store.selectSignal((s) => s[TASK_FEATURE_NAME].entities[id]!)();

  // The task as TaskService hands it over: read from the store at each tick.
  const tick = (id = 'task-1', date = DAY): string => {
    service.addTick(storedTask(id), 1000, date);
    return dispatched[dispatched.length - 1].type;
  };

  const ADD = TimeTrackingActions.addTimeSpent.type;
  const BUFFER = TimeTrackingActions.bufferTimeSpent.type;

  it('adds every tick to the task without Electron', () => {
    setup(false, [createTask('task-1', { timeSpentOnDay: { [DAY]: 60000 } })]);

    expect([tick(), tick(), tick()]).toEqual([ADD, ADD, ADD]);
    expect(storedTask().timeSpent).toBe(63000);
  });

  it('buffers ticks on desktop until the whole minutes change', () => {
    setup(true, [
      createTask('task-1', { timeSpentOnDay: { [DAY]: 60000 }, timeSpent: 60000 }),
    ]);

    // The first tick for a task shows at once (auto-add to Today, work start).
    expect(tick()).toBe(ADD);
    expect(storedTask().timeSpent).toBe(61000);
    for (let i = 0; i < 58; i++) {
      expect(tick()).toBe(BUFFER);
    }
    expect(storedTask().timeSpent).toBe(61000);

    expect(tick()).toBe(ADD);
    expect(storedTask().timeSpent).toBe(120000);
    expect(storedTask().timeSpentOnDay).toEqual({ [DAY]: 120000 });
    expect(tick()).toBe(BUFFER);
  });

  it("adds the tick that changes the day's minutes", () => {
    setup(true, [
      createTask('task-1', {
        timeSpentOnDay: { [DAY]: 58000, ['2026-01-04']: 32000 },
        timeSpent: 90000,
      }),
    ]);

    expect(tick()).toBe(ADD);
    // Day 59s -> 60s while the total stays at 1:31 -> 1:32.
    expect(tick()).toBe(ADD);
    expect(tick()).toBe(BUFFER);
  });

  it('adds the tick that exceeds the estimate', () => {
    setup(true, [
      createTask('task-1', {
        timeSpentOnDay: { [DAY]: 60000 },
        timeSpent: 60000,
        timeEstimate: 62500,
      }),
    ]);

    expect([tick(), tick(), tick(), tick()]).toEqual([ADD, BUFFER, ADD, BUFFER]);
    expect(storedTask().timeSpent).toBe(63000);
  });

  it('adds the first tick after switching task or day', () => {
    setup(true, [
      createTask('task-1', { timeSpentOnDay: { [DAY]: 60000 }, timeSpent: 60000 }),
      createTask('task-2', { timeSpentOnDay: { [DAY]: 60000 }, timeSpent: 60000 }),
    ]);

    expect([tick(), tick()]).toEqual([ADD, BUFFER]);
    expect(tick('task-2')).toBe(ADD);
    // Switching added task-1's buffered tick to it.
    expect(storedTask('task-1').timeSpent).toBe(62000);
    expect(tick('task-1')).toBe(ADD);
    expect(tick('task-1', '2026-01-06')).toBe(ADD);
  });

  it('batches every tick for sync, buffered or not', () => {
    setup(true, [
      createTask('task-1', { timeSpentOnDay: { [DAY]: 60000 }, timeSpent: 60000 }),
    ]);
    for (let i = 0; i < 10; i++) {
      tick();
    }

    service.flush();

    const sync = dispatched.filter((a) => a.type === syncTimeSpent.type);
    expect(sync.length).toBe(1);
    expect((sync[0] as ReturnType<typeof syncTimeSpent>).duration).toBe(10000);
    expect(storedTask().timeSpent).toBe(70000);
  });

  // Delete reads the task after flushOne, so the deleted copy must hold every tick.
  it('adds buffered ticks to the task when flushing that task', () => {
    setup(true, [
      createTask('task-1', { timeSpentOnDay: { [DAY]: 60000 }, timeSpent: 60000 }),
    ]);
    expect([tick(), tick(), tick()]).toEqual([ADD, BUFFER, BUFFER]);

    service.flushOne('task-1');

    expect(storedTask().timeSpent).toBe(63000);
    expect(storedTask().timeSpentOnDay).toEqual({ [DAY]: 63000 });
  });
});
