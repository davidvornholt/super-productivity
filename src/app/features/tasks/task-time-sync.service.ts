import { inject, Injectable, Signal } from '@angular/core';
import { Store } from '@ngrx/store';
import {
  BatchedTimeSyncAccumulator,
  BatchedTimeSyncEntry,
} from '../../core/util/batched-time-sync-accumulator';
import { AppStateSnapshot } from '../../op-log/core/types/backup.types';
import { RootState } from '../../root-store/root-state';
import { IS_ELECTRON_TOKEN } from '../../app.constants';
import {
  syncTimeSpent,
  TimeTrackingActions,
} from '../time-tracking/store/time-tracking.actions';
import { Task, TaskState } from './task.model';
import { selectTaskTimeBuffer } from './store/task-time-buffer.selectors';
import { TaskTimeBuffer } from './store/task-time-buffer.reducer';
import { projectPendingTimeFromTaskState } from './util/project-pending-time-from-task-state';

const MINUTE_MS = 60 * 1000;

/**
 * Owns the task-time batching state shared by live tracking and replay-safe snapshots.
 */
@Injectable({ providedIn: 'root' })
export class TaskTimeSyncService {
  private static readonly SYNC_INTERVAL_MS = 5 * 60 * 1000;
  private readonly _store = inject<Store<RootState>>(Store);
  // Desktop only: Android re-syncs its tracking notification whenever the
  // stored task time jumps by more than a few seconds, and the web build was
  // not measured.
  private readonly _isBufferingTicks = inject(IS_ELECTRON_TOKEN);
  // Created when a desktop tick first needs it; no other platform reads it.
  private _taskTimeBuffer?: Signal<TaskTimeBuffer | null>;
  private _lastTickKey: string | null = null;
  private readonly _accumulator = new BatchedTimeSyncAccumulator(
    TaskTimeSyncService.SYNC_INTERVAL_MS,
    (taskId, date, duration) => {
      this._store.dispatch(syncTimeSpent({ taskId, date, duration }));
    },
  );

  /**
   * Adds a tracking tick to the task and to the sync batch. On desktop, a tick
   * that changes nothing the app shows goes to the store-side TaskTimeBuffer
   * instead of the task, so views that show the task stop re-rendering every
   * second. The batch gets every tick either way.
   */
  addTick(task: Task, duration: number, date: string): void {
    this.accumulate(task.id, duration, date);
    if (this._isBufferingTicks && !this._isTickVisible(task, duration, date)) {
      this._store.dispatch(
        TimeTrackingActions.bufferTimeSpent({ taskId: task.id, date, duration }),
      );
    } else {
      // A buffer is added to its task before this action reduces.
      this._store.dispatch(
        TimeTrackingActions.addTimeSpent({
          task,
          date,
          duration,
          isFromTrackingReminder: false,
          isBackfill: false,
        }),
      );
    }
  }

  /**
   * Whether the tick changes something shown or acted on: the task's or the
   * day's whole minutes, the estimate being exceeded, or the first tick for a
   * task or day, which auto-adds the task to Today and stamps the work start.
   */
  private _isTickVisible(task: Task, duration: number, date: string): boolean {
    const key = `${task.id}:${date}`;
    const isFirstTick = key !== this._lastTickKey;
    this._lastTickKey = key;
    if (isFirstTick) {
      return true;
    }
    this._taskTimeBuffer ??= this._store.selectSignal(selectTaskTimeBuffer);
    const buffer = this._taskTimeBuffer();
    const buffered =
      buffer && buffer.taskId === task.id && buffer.date === date ? buffer.duration : 0;
    const before = task.timeSpent + buffered;
    const dayBefore =
      ((task.timeSpentOnDay && task.timeSpentOnDay[date]) || 0) + buffered;
    const isMinuteChange = (from: number): boolean =>
      Math.floor(from / MINUTE_MS) !== Math.floor((from + duration) / MINUTE_MS);
    return (
      isMinuteChange(before) ||
      isMinuteChange(dayBefore) ||
      (task.timeEstimate > 0 &&
        before <= task.timeEstimate &&
        before + duration > task.timeEstimate)
    );
  }

  accumulate(taskId: string, duration: number, date: string): void {
    this._accumulator.accumulate(taskId, duration, date);
  }

  shouldFlush(): boolean {
    return this._accumulator.shouldFlush();
  }

  flush(): void {
    this._accumulator.flush();
  }

  flushOne(taskId: string): void {
    this._accumulator.flushOne(taskId);
  }

  clearOne(taskId: string): void {
    this._accumulator.clearOne(taskId);
  }

  clear(): void {
    this._accumulator.clear();
  }

  projectSnapshot(
    snapshot: AppStateSnapshot,
    additionalPendingEntries: BatchedTimeSyncEntry[] = [],
  ): AppStateSnapshot {
    const pendingEntries = [
      ...this._accumulator.getPendingEntries(),
      ...additionalPendingEntries,
    ];
    if (pendingEntries.length === 0) {
      return snapshot;
    }

    const taskState = snapshot.task as TaskState;
    const projectedTaskState = projectPendingTimeFromTaskState(taskState, pendingEntries);
    return projectedTaskState === taskState
      ? snapshot
      : { ...snapshot, task: projectedTaskState };
  }
}
