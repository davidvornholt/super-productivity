import { TimeTrackingActions } from '../../time-tracking/store/time-tracking.actions';
import { TaskTimeBuffer, taskTimeBufferReducer } from './task-time-buffer.reducer';

const DAY = '2026-01-05';
const TICK_AT = new Date(2026, 0, 5, 10, 0, 0).getTime();
const STAMPS = { firstTickAt: TICK_AT, lastTickAt: TICK_AT };

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
