import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngrx/store';
import { IS_ELECTRON_TOKEN } from '../../app.constants';
import { DateService } from '../../core/date/date.service';
import { GlobalTrackingIntervalService } from '../../core/global-tracking-interval/global-tracking-interval.service';
import { taskTimeBufferMetaReducer } from '../../root-store/meta/task-time-buffer.meta-reducer';
import { timeTrackingReducer } from '../time-tracking/store/time-tracking.reducer';
import { initialTaskState, taskReducer } from './store/task.reducer';
import { selectTaskFeatureState } from './store/task.selectors';
import { taskTimeBufferReducer } from './store/task-time-buffer.reducer';
import { selectTaskTimeBuffer } from './store/task-time-buffer.selectors';
import { DEFAULT_TASK, Task } from './task.model';
import { TaskTimeSyncService } from './task-time-sync.service';

// Real elapsed-clock and date services with the real desktop reducers.
describe('Desktop tick buffer across a logical-day boundary', () => {
  let store: Store;
  let sync: TaskTimeSyncService;
  let clock: GlobalTrackingIntervalService;
  let date: DateService;
  let now: number;

  beforeEach(() => {
    now = new Date(2026, 0, 5, 3, 59, 56).getTime();
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(now));
    TestBed.configureTestingModule({
      providers: [
        provideStore(
          {
            tasks: taskReducer,
            taskTimeBuffer: taskTimeBufferReducer,
            timeTracking: timeTrackingReducer,
          },
          {
            metaReducers: [taskTimeBufferMetaReducer],
            initialState: {
              tasks: {
                ...initialTaskState,
                ids: ['clock-task'],
                entities: {
                  ['clock-task']: {
                    ...DEFAULT_TASK,
                    id: 'clock-task',
                    title: 'clock-task',
                    projectId: 'INBOX',
                  },
                },
                currentTaskId: 'clock-task',
              },
            },
          },
        ),
        { provide: IS_ELECTRON_TOKEN, useValue: true },
      ],
    });
    store = TestBed.inject(Store);
    sync = TestBed.inject(TaskTimeSyncService);
    date = TestBed.inject(DateService);
    clock = TestBed.inject(GlobalTrackingIntervalService);
  });

  afterEach(() => jasmine.clock().uninstall());

  const current = (): Task =>
    store.selectSignal(selectTaskFeatureState)().entities['clock-task']!;
  const advance = (duration: number): void => {
    now += duration;
    jasmine.clock().mockDate(new Date(now));
    const tick = clock.consumeCurrentTick();
    sync.addTick(current(), tick.duration, tick.date);
  };

  it('preserves both buckets across a 04:00 logical-day boundary', () => {
    date.setStartOfNextDayDiff('04:00');
    advance(1000);
    advance(1000);
    advance(1000);
    expect(store.selectSignal(selectTaskTimeBuffer)()?.duration).toBe(2000);
    advance(1000);
    advance(1000);
    sync.flush();
    expect(current().timeSpentOnDay).toEqual({
      ['2026-01-04']: 3000,
      ['2026-01-05']: 2000,
    });
    expect(current().timeSpent).toBe(5000);
    expect(store.selectSignal(selectTaskTimeBuffer)()).toBeNull();
  });
});
