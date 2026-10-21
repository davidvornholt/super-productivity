import { DEFAULT_TASK, Task } from '../task.model';
import {
  selectCurrentTaskWithBufferedTime,
  selectTaskTimeBuffer,
} from './task-time-buffer.selectors';

const DAY = '2026-01-05';

describe('task time buffer selectors', () => {
  const task: Task = {
    ...DEFAULT_TASK,
    id: 'task-1',
    title: 'task-1',
    projectId: 'project-1',
    timeSpentOnDay: { [DAY]: 60000, ['2026-01-04']: 30000 },
    timeSpent: 90000,
  };

  describe('selectTaskTimeBuffer', () => {
    it('reads null from a store without the buffer or without state', () => {
      expect(selectTaskTimeBuffer({})).toBeNull();
      expect(selectTaskTimeBuffer(undefined)).toBeNull();
    });
  });

  describe('selectCurrentTaskWithBufferedTime', () => {
    const project = selectCurrentTaskWithBufferedTime.projector;

    it('adds the buffered time to the current task', () => {
      const result = project(task, { taskId: 'task-1', date: DAY, duration: 5000 });

      expect(result).toEqual({
        ...task,
        timeSpent: 95000,
        timeSpentOnDay: { [DAY]: 65000, ['2026-01-04']: 30000 },
      });
    });

    it('adds a day the task has no time on yet', () => {
      const result = project(
        { ...task, timeSpentOnDay: {}, timeSpent: 0 },
        { taskId: 'task-1', date: DAY, duration: 5000 },
      );

      expect(result!.timeSpentOnDay).toEqual({ [DAY]: 5000 });
      expect(result!.timeSpent).toBe(5000);
    });

    it('returns the task unchanged without a buffer for it', () => {
      expect(project(task, null)).toBe(task);
      expect(project(task, { taskId: 'other', date: DAY, duration: 5000 })).toBe(task);
    });

    it('returns null without a current task', () => {
      expect(project(null, { taskId: 'task-1', date: DAY, duration: 5000 })).toBeNull();
    });
  });
});
