import { createReducer, on } from '@ngrx/store';
import { TimeTrackingActions } from '../../time-tracking/store/time-tracking.actions';
import { TaskState } from '../task.model';
import { updateTimeSpentForTask } from './task.reducer.util';

export const TASK_TIME_BUFFER_FEATURE_KEY = 'taskTimeBuffer' as const;

/**
 * Tracked time not yet added to its task. On desktop, a tracking tick that
 * leaves the task's whole minutes unchanged lands here instead of on the task,
 * so the task entity, and every view of it, changes once a minute instead of
 * every second (see TaskTimeSyncService.addTick).
 *
 * Local state, never persisted. taskTimeBufferMetaReducer adds the buffer to
 * its task before any other action reduces, and StateSnapshotService adds it to
 * every snapshot, so only selector reads between two actions miss it.
 */
export interface TaskTimeBuffer {
  taskId: string;
  date: string;
  duration: number;
}

export const taskTimeBufferReducer = createReducer<TaskTimeBuffer | null>(
  null,
  on(TimeTrackingActions.bufferTimeSpent, (state, { taskId, date, duration }) =>
    // The meta-reducer adds a buffer for another task or day to its task
    // before this runs, so a non-matching state is only ever null here.
    state && state.taskId === taskId && state.date === date
      ? { ...state, duration: state.duration + duration }
      : { taskId, date, duration },
  ),
);

/** Adds buffered time to its task exactly as the addTimeSpent reducer would. */
export const addBufferedTimeToTaskState = (
  taskState: TaskState,
  buffer: TaskTimeBuffer | null | undefined,
): TaskState => {
  const task = buffer && taskState.entities[buffer.taskId];
  if (!buffer || !task) {
    return taskState;
  }
  return updateTimeSpentForTask(
    task.id,
    {
      ...task.timeSpentOnDay,
      [buffer.date]:
        ((task.timeSpentOnDay && +task.timeSpentOnDay[buffer.date]) || 0) +
        buffer.duration,
    },
    taskState,
  );
};
