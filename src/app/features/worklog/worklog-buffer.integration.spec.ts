import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DateAdapter } from '@angular/material/core';
import { Router } from '@angular/router';
import { provideStore, Store } from '@ngrx/store';
import { firstValueFrom, of, Subject } from 'rxjs';
import { IS_ELECTRON_TOKEN } from '../../app.constants';
import { DateService } from '../../core/date/date.service';
import { DateTimeFormatService } from '../../core/date-time-format/date-time-format.service';
import { DataInitStateService } from '../../core/data-init/data-init-state.service';
import { GlobalTrackingIntervalService } from '../../core/global-tracking-interval/global-tracking-interval.service';
import { ArchiveDbAdapter } from '../../core/persistence/archive-db-adapter.service';
import { ImexViewService } from '../../imex/imex-meta/imex-view.service';
import { LockService } from '../../op-log/sync/lock.service';
import { taskTimeBufferMetaReducer } from '../../root-store/meta/task-time-buffer.meta-reducer';
import { taskSharedCrudMetaReducer } from '../../root-store/meta/task-shared-meta-reducers/task-shared-crud.reducer';
import { appStateReducer } from '../../root-store/app-state/app-state.reducer';
import { ArchiveService } from '../archive/archive.service';
import { TaskArchiveService } from '../archive/task-archive.service';
import { GlobalConfigService } from '../config/global-config.service';
import { initialProjectState, projectReducer } from '../project/store/project.reducer';
import { tagReducer } from '../tag/store/tag.reducer';
import { initialTaskState, taskReducer } from '../tasks/store/task.reducer';
import { taskTimeBufferReducer } from '../tasks/store/task-time-buffer.reducer';
import { selectTaskTimeBuffer } from '../tasks/store/task-time-buffer.selectors';
import { DEFAULT_TASK, Task } from '../tasks/task.model';
import { TaskFocusService } from '../tasks/task-focus.service';
import { TaskService } from '../tasks/task.service';
import { timeTrackingReducer } from '../time-tracking/store/time-tracking.reducer';
import { WorkContextService } from '../work-context/work-context.service';
import { WorkContextType } from '../work-context/work-context.model';
import { WorklogService } from './worklog.service';

const DAY = '2026-01-05';
const TASK = 'buffer-test';

// Real tracking service, NgRx reducers/meta-reducers, task reader and worklog loader.
// Only unrelated UI dependencies and the empty archive storage boundary are stubbed.
describe('Worklog reads during desktop buffered tracking', () => {
  let taskService: TaskService;
  let worklog: WorklogService;
  let store: Store;
  let ticks: Subject<{ duration: number; date: string }>;

  beforeEach(() => {
    ticks = new Subject();
    const projectId = initialProjectState.ids[0] as string;
    const task: Task = {
      ...DEFAULT_TASK,
      id: TASK,
      title: TASK,
      projectId,
      created: 1,
      timeSpentOnDay: { [DAY]: 60000 },
      timeSpent: 60000,
    };
    TestBed.configureTestingModule({
      providers: [
        provideStore(
          {
            tasks: taskReducer,
            taskTimeBuffer: taskTimeBufferReducer,
            timeTracking: timeTrackingReducer,
            tag: tagReducer,
            projects: projectReducer,
            appState: appStateReducer,
          },
          {
            metaReducers: [taskTimeBufferMetaReducer, taskSharedCrudMetaReducer],
            initialState: {
              tasks: {
                ...initialTaskState,
                ids: [TASK],
                entities: { [TASK]: task },
              },
              appState: { todayStr: DAY, startOfNextDayDiffMs: 0 },
            },
          },
        ),
        { provide: IS_ELECTRON_TOKEN, useValue: true },
        {
          provide: WorkContextService,
          useValue: {
            startableTasksForActiveContext: signal([]),
            activeWorkContext$: of({ id: projectId, type: WorkContextType.PROJECT }),
          },
        },
        { provide: GlobalTrackingIntervalService, useValue: { tick$: ticks } },
        { provide: DateService, useValue: { todayStr: () => DAY } },
        { provide: Router, useValue: { events: new Subject() } },
        { provide: ArchiveService, useValue: {} },
        {
          provide: TaskArchiveService,
          useValue: { load: async () => ({ ids: [], entities: {} }) },
        },
        {
          provide: ArchiveDbAdapter,
          useValue: {
            loadArchiveYoung: async () => undefined,
            loadArchiveOld: async () => undefined,
          },
        },
        { provide: LockService, useValue: {} },
        {
          provide: GlobalConfigService,
          useValue: { appFeatures: signal({ isTimeTrackingEnabled: true }) },
        },
        { provide: TaskFocusService, useValue: {} },
        { provide: ImexViewService, useValue: { isDataImportInProgress$: of(false) } },
        {
          provide: DataInitStateService,
          useValue: { isAllDataLoadedInitially$: of(true) },
        },
        { provide: DateTimeFormatService, useValue: { textLocale: () => 'en' } },
        { provide: DateAdapter, useValue: { getFirstDayOfWeek: () => 1 } },
      ],
    });
    store = TestBed.inject(Store);
    taskService = TestBed.inject(TaskService);
    worklog = TestBed.inject(WorklogService);
    taskService.setCurrentId(TASK);
  });

  afterEach(() => ticks.complete());

  it('includes pending seconds when loading export rows and metrics', async () => {
    ticks.next({ date: DAY, duration: 1000 });
    ticks.next({ date: DAY, duration: 17000 });
    expect(store.selectSignal(selectTaskTimeBuffer)()?.duration).toBe(17000);

    const rows = await firstValueFrom(
      worklog.getTaskListForRange$(new Date(2026, 0, 5), new Date(2026, 0, 5), true),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].timeSpent).toBe(78000);
    expect(rows[0].timeSpentOnDay[DAY]).toBe(78000);
    expect(await firstValueFrom(worklog.totalTimeSpent$)).toBe(78000);
  });

  it('includes the pending rounded work-end stamp when opening the worklog', async () => {
    const now = spyOn(Date, 'now');
    now.and.returnValue(new Date(2026, 0, 5, 10, 0, 5).getTime());
    ticks.next({ date: DAY, duration: 1000 });
    now.and.returnValue(new Date(2026, 0, 5, 10, 0, 36).getTime());
    ticks.next({ date: DAY, duration: 31000 });

    const result = await firstValueFrom(worklog.worklog$);
    expect(result[2026].ent[1].ent[5].workEnd).toBe(
      new Date(2026, 0, 5, 10, 1).getTime(),
    );
  });
});
