import { Action, ActionReducer } from '@ngrx/store';
import { RootState } from '../root-state';
import { TASK_FEATURE_NAME } from '../../features/tasks/store/task.reducer';
import {
  addTimeSpentForBuffer,
  TASK_TIME_BUFFER_FEATURE_KEY,
  TaskTimeBuffer,
} from '../../features/tasks/store/task-time-buffer.reducer';
import { TimeTrackingActions } from '../../features/time-tracking/store/time-tracking.actions';
import { tick as focusTimerTick } from '../../features/focus-mode/store/focus-mode.actions';

const isBufferActionFor = (action: Action, buffer: TaskTimeBuffer): boolean => {
  if (action.type !== TimeTrackingActions.bufferTimeSpent.type) {
    return false;
  }
  const { taskId, date } = action as ReturnType<
    typeof TimeTrackingActions.bufferTimeSpent
  >;
  return taskId === buffer.taskId && date === buffer.date;
};

/**
 * Adds buffered tick time (see TaskTimeBuffer) to its task and work-context
 * stamps before other actions reduce. Only the next tick for the same task
 * and day, and the local focus display tick, leave the buffer in place.
 * Focus ticks read their own absolute timer, not task time. Their completion
 * effect dispatches a separate transition which still flushes before reducing.
 *
 * The time goes through the inner reducers as an addTimeSpent pass; that
 * action is never dispatched, so effects and plugins do not see it.
 */
export const taskTimeBufferMetaReducer = (
  reducer: ActionReducer<any, any>,
): ActionReducer<any, any> => {
  return (state: RootState | undefined, action: Action) => {
    const buffer = state?.[TASK_TIME_BUFFER_FEATURE_KEY];
    if (
      !state ||
      !buffer ||
      isBufferActionFor(action, buffer) ||
      action.type === focusTimerTick.type
    ) {
      return reducer(state, action);
    }
    const task = state[TASK_FEATURE_NAME].entities[buffer.taskId];
    const stateWithTime: RootState = task
      ? reducer(state, addTimeSpentForBuffer(task, buffer))
      : state;
    return reducer({ ...stateWithTime, [TASK_TIME_BUFFER_FEATURE_KEY]: null }, action);
  };
};
