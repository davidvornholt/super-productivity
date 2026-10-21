import { TimeTrackingActions } from '../../time-tracking/store/time-tracking.actions';
import { DEFAULT_TASK, Task, TaskState } from '../task.model';
import { initialTaskState, taskReducer } from './task.reducer';
import {
  addBufferedTimeToTaskState,
  TaskTimeBuffer,
  taskTimeBufferReducer,
} from './task-time-buffer.reducer';

const DAY = '2026-01-05';
const TICK_AT = new Date(2026, 0, 5, 10, 0, 0).getTime();
const STAMPS = { firstTickAt: TICK_AT, lastTickAt: TICK_AT };

const createTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  ...DEFAULT_TASK,
  id,
  title: id,
  projectId: 'project-1',
  ...overrides,
});

const createTaskState = (tasks: Task[]): TaskState => ({
  ...initialTaskState,
  ids: tasks.map((t) => t.id),
  entities: Object.fromEntries(tasks.map((t) => [t.id, t])),
});

describe('taskTimeBufferReducer', () => {
  beforeEach(() => {
    spyOn(Date, 'now').and.returnValue(TICK_AT);
  });
  const buffer = (
    taskId: string,
    duration: number,
    date = DAY,
  ): ReturnType<typeof TimeTrackingActions.bufferTimeSpent> =>
    TimeTrackingActions.bufferTimeSpent({ taskId, date, duration });

  it('starts empty', () => {
    expect(taskTimeBufferReducer(undefined, { type: 'INIT' })).toBeNull();
  });

  it('starts a buffer on the first buffered tick', () => {
    expect(taskTimeBufferReducer(null, buffer('task-1', 1000))).toEqual({
      ...STAMPS,
      taskId: 'task-1',
      date: DAY,
      duration: 1000,
    });
  });

  it('adds further ticks for the same task and day', () => {
    (Date.now as jasmine.Spy).and.returnValues(TICK_AT, TICK_AT + 1500);
    const state = taskTimeBufferReducer(
      taskTimeBufferReducer(null, buffer('task-1', 1000)),
      buffer('task-1', 1500),
    );

    expect(state).toEqual({
      ...STAMPS,
      lastTickAt: TICK_AT + 1500,
      taskId: 'task-1',
      date: DAY,
      duration: 2500,
    });
  });

  it('starts over for another task or day', () => {
    const state: TaskTimeBuffer = {
      ...STAMPS,
      taskId: 'task-1',
      date: DAY,
      duration: 5000,
    };

    expect(taskTimeBufferReducer(state, buffer('task-2', 1000))).toEqual({
      ...STAMPS,
      taskId: 'task-2',
      date: DAY,
      duration: 1000,
    });
    expect(taskTimeBufferReducer(state, buffer('task-1', 1000, '2026-01-06'))).toEqual({
      ...STAMPS,
      taskId: 'task-1',
      date: '2026-01-06',
      duration: 1000,
    });
  });
});

describe('addBufferedTimeToTaskState', () => {
  it('adds the buffer exactly as addTimeSpent would, parent included', () => {
    const parent = createTask('parent', {
      subTaskIds: ['sub'],
      timeSpentOnDay: { [DAY]: 120000 },
      timeSpent: 120000,
    });
    const sub = createTask('sub', {
      parentId: 'parent',
      timeSpentOnDay: { [DAY]: 60000, ['2026-01-04']: 30000 },
      timeSpent: 90000,
    });
    const state = createTaskState([parent, sub]);

    const viaBuffer = addBufferedTimeToTaskState(state, {
      ...STAMPS,
      taskId: 'sub',
      date: DAY,
      duration: 4000,
    });
    const viaAction = taskReducer(
      state,
      TimeTrackingActions.addTimeSpent({
        task: sub,
        date: DAY,
        duration: 4000,
        isFromTrackingReminder: false,
      }),
    );

    expect(viaBuffer).toEqual(viaAction);
    expect(viaBuffer.entities['sub']!.timeSpent).toBe(94000);
  });

  it('adds a day the task has no time on yet', () => {
    const state = createTaskState([createTask('task-1')]);

    const result = addBufferedTimeToTaskState(state, {
      ...STAMPS,
      taskId: 'task-1',
      date: DAY,
      duration: 3000,
    });

    expect(result.entities['task-1']!.timeSpentOnDay).toEqual({ [DAY]: 3000 });
    expect(result.entities['task-1']!.timeSpent).toBe(3000);
  });

  it('returns the same state without a buffer or without the task', () => {
    const state = createTaskState([createTask('task-1')]);

    expect(addBufferedTimeToTaskState(state, null)).toBe(state);
    expect(
      addBufferedTimeToTaskState(state, {
        ...STAMPS,
        taskId: 'gone',
        date: DAY,
        duration: 1000,
      }),
    ).toBe(state);
  });
});
