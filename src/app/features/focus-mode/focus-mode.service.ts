import { computed, inject, Injectable, Signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { Store } from '@ngrx/store';
import { filter, tap } from 'rxjs/operators';
import * as actions from './store/focus-mode.actions';
import * as selectors from './store/focus-mode.selectors';
import { GlobalConfigService } from '../config/global-config.service';
import { selectFocusModeConfig } from '../config/store/global-config.reducer';
import { FocusModeMode, getCountdownDurationForTask } from './focus-mode.model';
import { FocusModeStrategyFactory } from './focus-mode-strategies';
import { TaskCopy } from '../tasks/task.model';
import { GlobalTrackingIntervalService } from '../../core/global-tracking-interval/global-tracking-interval.service';

@Injectable({
  providedIn: 'root',
})
export class FocusModeService {
  private _store = inject(Store);
  private _globalConfigService = inject(GlobalConfigService);
  private _globalTrackingInterval = inject(GlobalTrackingIntervalService);
  private _strategyFactory = inject(FocusModeStrategyFactory);
  // store.selectSignal marks its consumers dirty on every store change before
  // comparing values, so the always-rendered focus button and effects reading
  // these scheduled change detection for every action, e.g. each tracking tick.
  // store.select emits only changed values.
  private _selectSignal<T>(selector: (state: object) => T): Signal<T> {
    return toSignal(this._store.select(selector), { requireSync: true });
  }

  private _timer = this._selectSignal(selectors.selectTimer);

  // State signals
  currentScreen = this._selectSignal(selectors.selectCurrentScreen);
  mainState = this._selectSignal(selectors.selectMainState);
  mode = this._selectSignal(selectors.selectMode);
  isOverlayShown = this._selectSignal(selectors.selectIsOverlayShown);
  currentCycle = this._selectSignal(selectors.selectCurrentCycle);

  // Timer signals
  isRunning = this._selectSignal(selectors.selectIsRunning);
  timeElapsed = this._selectSignal(selectors.selectTimeElapsed);
  timeRemaining = this._selectSignal(selectors.selectTimeRemaining);
  progress = this._selectSignal(selectors.selectProgress);
  sessionDuration = this._selectSignal(selectors.selectTimeDuration);

  // Session signals
  isSessionRunning = this._selectSignal(selectors.selectIsSessionRunning);
  isSessionPaused = this._selectSignal(selectors.selectIsSessionPaused);
  isSessionCompleted = this._selectSignal(selectors.selectIsSessionCompleted);

  // Break signals
  isBreakActive = this._selectSignal(selectors.selectIsBreakActive);
  isLongBreak = this._selectSignal(selectors.selectIsLongBreak);

  // Config signals
  pomodoroConfig = this._globalConfigService.pomodoroConfig;
  focusModeConfig = this._selectSignal(selectFocusModeConfig);

  // Overtime
  isInOvertime = this._selectSignal(selectors.selectIsInOvertime);

  // Compatibility aliases (TODO: remove when components are updated)
  isBreakLong = this.isLongBreak;

  // Additional compatibility signals
  lastSessionTotalDurationOrTimeElapsedFallback = this._selectSignal(
    selectors.selectLastSessionDuration,
  );

  // UI helper signals
  isCountTimeDown = computed(() => this.mode() !== FocusModeMode.Flowtime);

  // Observable versions for compatibility
  sessionProgress$ = this._store.select(selectors.selectProgress);
  currentSessionTime$ = this._store.select(selectors.selectTimeElapsed);
  timeToGo$ = this._store.select(selectors.selectTimeRemaining);

  // Single timer that updates the store at 1-second intervals for smooth UI
  constructor() {
    // Reuse the shared global 1-second interval to coalesce both ticks
    // into the same event loop turn, reducing change detection overhead
    this._globalTrackingInterval.globalInterval$
      .pipe(
        filter(() => this.isRunning() === true),
        tap(() => this._store.dispatch(actions.tick())),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

  /** Open the rich focus-mode overlay. Used by the header button. */
  openOverlay(): void {
    this._store.dispatch(actions.showFocusOverlay());
  }

  /**
   * Start a session for `task` right away in the last-used mode and show the
   * overlay, skipping the setup screen. Returns false (and does nothing) when a
   * session or break is already active or the user opted into the preparation
   * screen — callers then fall back to just opening the overlay.
   */
  tryStartSessionForTask(task: TaskCopy): boolean {
    if (this._timer().purpose !== null || this.focusModeConfig()?.isShowPreparation) {
      return false;
    }
    const mode = this.mode();
    const defaultDuration =
      this._strategyFactory.getStrategy(mode).initialSessionDuration;
    const duration =
      mode === FocusModeMode.Countdown
        ? getCountdownDurationForTask(defaultDuration, task)
        : defaultDuration;
    // the startFocusSession effect activates tracking for taskId
    this._store.dispatch(actions.startFocusSession({ duration, taskId: task.id }));
    this._store.dispatch(actions.showFocusOverlay());
    return true;
  }
}
