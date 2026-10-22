import { createReducer, on } from '@ngrx/store';
import { TimeTrackingActions } from '../../time-tracking/store/time-tracking.actions';
import { Task } from '../task.model';

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
  firstTickAt: number;
  lastTickAt: number;
}

export const taskTimeBufferReducer = createReducer<TaskTimeBuffer | null>(
  null,
  on(TimeTrackingActions.bufferTimeSpent, (state, { taskId, date, duration }) => {
    // Keep the actual tick times: flushing can happen after a minute boundary
    // or an overnight suspension. These stamps are local, like the buffer.
    const now = Date.now();
    // The meta-reducer adds a buffer for another task or day to its task
    // before this runs, so a non-matching state is only ever null here.
    return state && state.taskId === taskId && state.date === date
      ? { ...state, duration: state.duration + duration, lastTickAt: now }
      : { taskId, date, duration, firstTickAt: now, lastTickAt: now };
  }),
);

/**
 * The addTimeSpent pass that adds a buffer to its task: task time plus the
 * work-context start and end stamps. Never dispatched; taskTimeBufferMetaReducer
 * and StateSnapshotService run it through the reducers directly.
 */
export const addTimeSpentForBuffer = (
  task: Task,
  buffer: TaskTimeBuffer,
): ReturnType<typeof TimeTrackingActions.addTimeSpent> =>
  TimeTrackingActions.addTimeSpent({
    task,
    date: buffer.date,
    duration: buffer.duration,
    isFromTrackingReminder: false,
    workStart: buffer.firstTickAt,
    workEnd: buffer.lastTickAt,
  });
