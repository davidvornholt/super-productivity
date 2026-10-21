import { createSelector } from '@ngrx/store';
import { Task } from '../task.model';
import { selectCurrentTask } from './task.selectors';
import { TASK_TIME_BUFFER_FEATURE_KEY, TaskTimeBuffer } from './task-time-buffer.reducer';

// A plain selector rather than createFeatureSelector: stores built without the
// feature or without any state (op-log harnesses, mock stores in specs) read
// null instead of warning or throwing.
export const selectTaskTimeBuffer = (
  state: { [TASK_TIME_BUFFER_FEATURE_KEY]?: TaskTimeBuffer | null } | undefined,
): TaskTimeBuffer | null => state?.[TASK_TIME_BUFFER_FEATURE_KEY] ?? null;

/**
 * The current task including buffered tick time, for consumers that show or
 * hand out seconds (desktop task widget, taskbar progress, Local REST API,
 * plugin current-task hook). Emits every second while a task is tracked, so
 * keep it out of rendered views: they show whole minutes and should only
 * change when the task entity does.
 */
export const selectCurrentTaskWithBufferedTime = createSelector(
  selectCurrentTask,
  selectTaskTimeBuffer,
  (task, buffer): Task | null =>
    task && buffer && buffer.taskId === task.id
      ? {
          ...task,
          timeSpent: task.timeSpent + buffer.duration,
          timeSpentOnDay: {
            ...task.timeSpentOnDay,
            [buffer.date]: (task.timeSpentOnDay?.[buffer.date] || 0) + buffer.duration,
          },
        }
      : task,
);
