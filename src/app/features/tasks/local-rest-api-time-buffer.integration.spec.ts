import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideStore, Store } from '@ngrx/store';
import { firstValueFrom, of, Subject } from 'rxjs';
import { IS_ELECTRON_TOKEN } from '../../app.constants';
import { DateService } from '../../core/date/date.service';
import { DataInitStateService } from '../../core/data-init/data-init-state.service';
import { GlobalTrackingIntervalService } from '../../core/global-tracking-interval/global-tracking-interval.service';
import { ImexViewService } from '../../imex/imex-meta/imex-view.service';
import { taskTimeBufferMetaReducer } from '../../root-store/meta/task-time-buffer.meta-reducer';
import { taskSharedCrudMetaReducer } from '../../root-store/meta/task-shared-meta-reducers/task-shared-crud.reducer';
import { appStateReducer } from '../../root-store/app-state/app-state.reducer';
import { ArchiveService } from '../archive/archive.service';
import { TaskArchiveService } from '../archive/task-archive.service';
import { GlobalConfigService } from '../config/global-config.service';
import { initialProjectState, projectReducer } from '../project/store/project.reducer';
import { tagReducer } from '../tag/store/tag.reducer';
import { initialTaskState, taskReducer } from './store/task.reducer';
import { taskTimeBufferReducer } from './store/task-time-buffer.reducer';
import { selectTaskTimeBuffer } from './store/task-time-buffer.selectors';
import { DEFAULT_TASK, Task } from './task.model';
import { TaskFocusService } from './task-focus.service';
import { TaskService } from './task.service';
import { timeTrackingReducer } from '../time-tracking/store/time-tracking.reducer';
import { WorkContextService } from '../work-context/work-context.service';
import { WorkContextType } from '../work-context/work-context.model';
import { LocalRestApiHandlerService } from '../../core/electron/local-rest-api-handler.service';
import { LOCAL_REST_API_FEATURE_BRIDGE } from '../../core/electron/local-rest-api-feature-bridge';
import { LocalRestApiFeatureBridgeService } from './local-rest-api-feature-bridge.service';
import { TaskTimeSyncService } from './task-time-sync.service';
import { IssueService } from '../issue/issue.service';
import { TaskMoveToProjectService } from './task-move-to-project.service';
import { ProjectService } from '../project/project.service';
import { TagService } from '../tag/tag.service';
import { ArchiveOperationHandler } from '../../op-log/apply/archive-operation-handler.service';

const DAY = '2026-01-05';
const TASK = 'buffer-test';

// Real tracking service, NgRx reducers/meta-reducers, REST route and feature bridge.
// Only unrelated UI dependencies and the empty archive storage boundary are stubbed.
describe('Local REST API time edits during desktop buffered tracking', () => {
  let taskService: TaskService;
  let handler: LocalRestApiHandlerService;
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
      timeSpentOnDay: { [DAY]: 86340000 },
      timeSpent: 86340000,
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
          provide: GlobalConfigService,
          useValue: { appFeatures: signal({ isTimeTrackingEnabled: true }) },
        },
        { provide: TaskFocusService, useValue: {} },
        { provide: ImexViewService, useValue: { isDataImportInProgress$: of(false) } },
        {
          provide: DataInitStateService,
          useValue: { isAllDataLoadedInitially$: of(true) },
        },
        {
          provide: LOCAL_REST_API_FEATURE_BRIDGE,
          useClass: LocalRestApiFeatureBridgeService,
        },
        { provide: IssueService, useValue: {} },
        { provide: TaskMoveToProjectService, useValue: {} },
        { provide: ProjectService, useValue: {} },
        { provide: TagService, useValue: {} },
        { provide: ArchiveOperationHandler, useValue: {} },
      ],
    });
    store = TestBed.inject(Store);
    taskService = TestBed.inject(TaskService);
    handler = TestBed.inject(LocalRestApiHandlerService);
    taskService.setCurrentId(TASK);
  });

  afterEach(() => ticks.complete());

  it('rejects a POST exceeding 24 hours after including buffered time', async () => {
    ticks.next({ date: DAY, duration: 1000 });
    ticks.next({ date: DAY, duration: 17000 });
    expect(store.selectSignal(selectTaskTimeBuffer)()?.duration).toBe(17000);

    const response = await handler['_routeRequest']({
      requestId: 'buffer-limit',
      method: 'POST',
      path: `/tasks/${TASK}/time`,
      query: {},
      body: { date: DAY, duration: 50000 },
    });
    expect(response.status).toBe(400);
    TestBed.inject(TaskTimeSyncService).flush();
    const task = await firstValueFrom(taskService.getByIdOnce$(TASK));
    expect(task.timeSpentOnDay[DAY]).toBe(86358000);
  });
});
