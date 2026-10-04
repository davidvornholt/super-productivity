import { TestBed } from '@angular/core/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { Observable, of } from 'rxjs';
import { LocalRestApiProjectRoutesService } from './local-rest-api-project-routes.service';
import { ProjectCompletionInfo, ProjectService } from './project.service';
import { Project } from './project.model';
import { DEFAULT_PROJECT, INBOX_PROJECT } from './project.const';
import { PROJECT_FEATURE_NAME } from './store/project.reducer';
import { DateService } from '../../core/date/date.service';
import { PRESET_COLORS } from '../../ui/work-context-color';
import { Task } from '../tasks/task.model';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';

describe('LocalRestApiProjectRoutesService', () => {
  let service: LocalRestApiProjectRoutesService;
  let store: MockStore;
  let projectServiceMock: jasmine.SpyObj<ProjectService>;
  let projects: Project[];

  const createProject = (id: string, overrides: Partial<Project> = {}): Project => ({
    ...DEFAULT_PROJECT,
    id,
    title: `Project ${id}`,
    ...overrides,
  });

  const emptyCompletionInfo: ProjectCompletionInfo = {
    topLevelTasks: [],
    allTasks: [],
    unfinishedTasks: [],
    topLevelTasksWithUnfinishedWork: [],
  };

  const setProjects = (next: Project[]): void => {
    projects = next;
    store.setState({
      [PROJECT_FEATURE_NAME]: {
        ids: next.map((p) => p.id),
        entities: Object.fromEntries(next.map((p) => [p.id, p])),
      },
    });
  };

  /** Applies `changes` like the reducer would, so responses show the result. */
  const patchProject = (id: string, changes: Partial<Project>): void =>
    setProjects(projects.map((p) => (p.id === id ? { ...p, ...changes } : p)));

  const createRequest = (
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | string[]> } = {},
  ): LocalRestApiRequestPayload => ({
    requestId: 'test-request-id',
    method,
    path,
    query: options.query ?? {},
    body: options.body,
  });

  const handle = async (
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload> => {
    const response = await service.handle(request);
    if (!response) {
      throw new Error(`Route not handled: ${request.method} ${request.path}`);
    }
    return response;
  };

  const errorCode = (response: LocalRestApiResponsePayload): string | undefined =>
    response.body.ok ? undefined : response.body.error.code;

  const data = (response: LocalRestApiResponsePayload): unknown =>
    response.body.ok ? response.body.data : undefined;

  beforeEach(() => {
    projectServiceMock = jasmine.createSpyObj<ProjectService>('ProjectService', [
      'add',
      'update',
      'complete',
      'reopen',
      'unarchive',
      'getCompletionInfo',
      'moveTasksToInbox',
      'markTasksDone',
    ]);
    Object.defineProperty(projectServiceMock, 'list$', {
      get: (): Observable<Project[]> => of(projects.filter((p) => !p.isArchived)),
    });
    projectServiceMock.add.and.callFake((project: Partial<Project>) => {
      setProjects([...projects, { ...DEFAULT_PROJECT, ...project, id: 'new-id' }]);
      return 'new-id';
    });
    projectServiceMock.update.and.callFake((id: string, changes: Partial<Project>) =>
      patchProject(id, changes),
    );
    projectServiceMock.complete.and.callFake((id: string, doneOn: number) =>
      patchProject(id, { isDone: true, doneOn, isArchived: true }),
    );
    projectServiceMock.reopen.and.callFake((id: string) =>
      patchProject(id, { isDone: false, doneOn: null, isArchived: false }),
    );
    projectServiceMock.unarchive.and.callFake(async (id: string) =>
      patchProject(id, { isDone: false, doneOn: null, isArchived: false }),
    );
    projectServiceMock.getCompletionInfo.and.resolveTo(emptyCompletionInfo);
    projectServiceMock.moveTasksToInbox.and.resolveTo();
    projectServiceMock.markTasksDone.and.resolveTo();

    const dateServiceMock = jasmine.createSpyObj<DateService>('DateService', [
      'getLogicalTodayDate',
    ]);
    dateServiceMock.getLogicalTodayDate.and.returnValue(new Date(2026, 4, 12));

    TestBed.configureTestingModule({
      providers: [
        LocalRestApiProjectRoutesService,
        { provide: ProjectService, useValue: projectServiceMock },
        { provide: DateService, useValue: dateServiceMock },
        provideMockStore(),
      ],
    });
    service = TestBed.inject(LocalRestApiProjectRoutesService);
    store = TestBed.inject(MockStore);

    setProjects([
      INBOX_PROJECT,
      createProject('p1', { title: 'Work' }),
      createProject('p2', { title: 'Personal' }),
      createProject('archived', { title: 'Old work', isArchived: true }),
    ]);
  });

  describe('GET /projects', () => {
    it('should return all unarchived projects', async () => {
      const response = await handle(createRequest('GET', '/projects'));

      expect(response.status).toBe(200);
      expect((data(response) as Project[]).map((p) => p.id)).toEqual([
        INBOX_PROJECT.id,
        'p1',
        'p2',
      ]);
    });

    it('should filter projects by title, case-insensitively', async () => {
      const response = await handle(
        createRequest('GET', '/projects', { query: { query: 'WORK' } }),
      );

      expect((data(response) as Project[]).map((p) => p.id)).toEqual(['p1']);
    });

    it('should include archived projects with includeArchived=true', async () => {
      const response = await handle(
        createRequest('GET', '/projects', {
          query: { query: 'work', includeArchived: 'true' },
        }),
      );

      expect((data(response) as Project[]).map((p) => p.id)).toEqual(['p1', 'archived']);
    });
  });

  describe('GET /projects/:id', () => {
    it('should return the project, archived or not', async () => {
      const response = await handle(createRequest('GET', '/projects/archived'));

      expect(response.status).toBe(200);
      expect((data(response) as Project).title).toBe('Old work');
    });

    it('should return 404 PROJECT_NOT_FOUND for an unknown id', async () => {
      const response = await handle(createRequest('GET', '/projects/missing'));

      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('PROJECT_NOT_FOUND');
    });

    it('should not resolve prototype member names as ids', async () => {
      const response = await handle(createRequest('GET', '/projects/__proto__'));

      expect(errorCode(response)).toBe('PROJECT_NOT_FOUND');
    });
  });

  describe('POST /projects', () => {
    it('should create a project with a random preset color', async () => {
      const response = await handle(
        createRequest('POST', '/projects', {
          body: { title: '  New project  ', icon: 'rocket', isEnableBacklog: true },
        }),
      );

      expect(response.status).toBe(201);
      const added = projectServiceMock.add.calls.mostRecent().args[0];
      expect(added.title).toBe('New project');
      expect(added.icon).toBe('rocket');
      expect(added.isEnableBacklog).toBe(true);
      expect(added.theme).toEqual({
        ...DEFAULT_PROJECT.theme,
        primary: jasmine.any(String),
      });
      expect(PRESET_COLORS).toContain(added.theme!.primary!);
      expect((data(response) as Project).id).toBe('new-id');
    });

    it('should use the given theme.primary color', async () => {
      await handle(
        createRequest('POST', '/projects', {
          body: { title: 'Colored', theme: { primary: '#123abc' } },
        }),
      );

      expect(projectServiceMock.add.calls.mostRecent().args[0].theme).toEqual({
        ...DEFAULT_PROJECT.theme,
        primary: '#123abc',
      });
    });

    it('should require a non-empty title', async () => {
      for (const body of [{}, { title: '   ' }]) {
        const response = await handle(createRequest('POST', '/projects', { body }));

        expect(response.status).toBe(400);
        expect(errorCode(response)).toBe('INVALID_INPUT');
      }
      expect(projectServiceMock.add).not.toHaveBeenCalled();
    });

    it('should reject a non-object body', async () => {
      const response = await handle(
        createRequest('POST', '/projects', { body: ['title'] }),
      );

      expect(errorCode(response)).toBe('INVALID_INPUT');
      expect(projectServiceMock.add).not.toHaveBeenCalled();
    });

    it('should reject fields outside the allowlist', async () => {
      const response = await handle(
        createRequest('POST', '/projects', {
          body: { title: 'X', taskIds: ['t1'], isArchived: true },
        }),
      );

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('UNSUPPORTED_FIELD');
      expect(response.body.ok ? undefined : response.body.error.details).toEqual({
        fields: ['taskIds', 'isArchived'],
      });
      expect(projectServiceMock.add).not.toHaveBeenCalled();
    });

    it('should reject theme fields other than primary', async () => {
      const response = await handle(
        createRequest('POST', '/projects', {
          body: { title: 'X', theme: { primary: '#fff', backgroundImageDark: 'x' } },
        }),
      );

      expect(errorCode(response)).toBe('UNSUPPORTED_FIELD');
      expect(projectServiceMock.add).not.toHaveBeenCalled();
    });

    it('should reject wrong value types with details', async () => {
      const response = await handle(
        createRequest('POST', '/projects', {
          body: { title: 'X', isEnableBacklog: 'yes', icon: 3 },
        }),
      );

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('INVALID_INPUT');
      const details = response.body.ok ? [] : (response.body.error.details as unknown[]);
      expect(details.length).toBe(2);
      expect(projectServiceMock.add).not.toHaveBeenCalled();
    });

    it('should reject a non-hex color and a non-object theme', async () => {
      for (const theme of [{ primary: 'red' }, { primary: '#12345' }, 'blue', null]) {
        const response = await handle(
          createRequest('POST', '/projects', { body: { title: 'X', theme } }),
        );

        expect(errorCode(response))
          .withContext(JSON.stringify(theme))
          .toBe('INVALID_INPUT');
      }
      expect(projectServiceMock.add).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /projects/:id', () => {
    it('should update the allowed fields', async () => {
      const response = await handle(
        createRequest('PATCH', '/projects/p1', {
          body: { title: ' Renamed ', icon: null, isHiddenFromMenu: true },
        }),
      );

      expect(projectServiceMock.update).toHaveBeenCalledOnceWith('p1', {
        title: 'Renamed',
        icon: null,
        isHiddenFromMenu: true,
      });
      expect(response.status).toBe(200);
      expect((data(response) as Project).title).toBe('Renamed');
    });

    it('should merge theme.primary into the existing theme', async () => {
      const theme = { ...DEFAULT_PROJECT.theme, isAutoContrast: false };
      patchProject('p1', { theme });

      await handle(
        createRequest('PATCH', '/projects/p1', { body: { theme: { primary: '#abc' } } }),
      );

      expect(projectServiceMock.update).toHaveBeenCalledOnceWith('p1', {
        theme: { ...theme, primary: '#abc' },
      });
    });

    it('should not dispatch when nothing changes', async () => {
      const response = await handle(
        createRequest('PATCH', '/projects/p1', { body: { theme: {} } }),
      );

      expect(response.status).toBe(200);
      expect(projectServiceMock.update).not.toHaveBeenCalled();
    });

    it('should return 404 for an unknown project', async () => {
      const response = await handle(
        createRequest('PATCH', '/projects/missing', { body: { title: 'X' } }),
      );

      expect(errorCode(response)).toBe('PROJECT_NOT_FOUND');
      expect(projectServiceMock.update).not.toHaveBeenCalled();
    });

    it('should validate before updating', async () => {
      for (const body of [{ title: '' }, { isDone: true }, { isEnableBacklog: 1 }]) {
        const response = await handle(createRequest('PATCH', '/projects/p1', { body }));

        expect(response.status).withContext(JSON.stringify(body)).toBe(400);
      }
      expect(projectServiceMock.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /projects/:id/complete', () => {
    const unfinished = [{ id: 't1' } as Task, { id: 't2' } as Task];

    it('should complete a project without unfinished tasks on the logical day', async () => {
      const response = await handle(createRequest('POST', '/projects/p1/complete'));

      expect(projectServiceMock.complete).toHaveBeenCalledOnceWith(
        'p1',
        new Date(2026, 4, 12).getTime(),
      );
      expect(response.status).toBe(200);
      expect((data(response) as Project).isDone).toBe(true);
    });

    it('should return 409 UNFINISHED_TASKS when the choice is missing', async () => {
      projectServiceMock.getCompletionInfo.and.resolveTo({
        ...emptyCompletionInfo,
        unfinishedTasks: unfinished,
      });

      const response = await handle(createRequest('POST', '/projects/p1/complete'));

      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('UNFINISHED_TASKS');
      expect(response.body.ok ? undefined : response.body.error.details).toEqual({
        unfinishedTaskIds: ['t1', 't2'],
      });
      expect(projectServiceMock.complete).not.toHaveBeenCalled();
    });

    it('should move unfinished work to the Inbox first', async () => {
      const topLevel = [{ id: 'parent' } as Task];
      projectServiceMock.getCompletionInfo.and.resolveTo({
        ...emptyCompletionInfo,
        unfinishedTasks: unfinished,
        topLevelTasksWithUnfinishedWork: topLevel,
      });

      await handle(
        createRequest('POST', '/projects/p1/complete', {
          body: { resolveUnfinishedTasks: 'inbox' },
        }),
      );

      expect(projectServiceMock.moveTasksToInbox).toHaveBeenCalledOnceWith(topLevel);
      expect(projectServiceMock.markTasksDone).not.toHaveBeenCalled();
      expect(projectServiceMock.complete).toHaveBeenCalled();
      expect(projectServiceMock.moveTasksToInbox).toHaveBeenCalledBefore(
        projectServiceMock.complete,
      );
    });

    it('should mark unfinished tasks done first', async () => {
      projectServiceMock.getCompletionInfo.and.resolveTo({
        ...emptyCompletionInfo,
        unfinishedTasks: unfinished,
      });

      await handle(
        createRequest('POST', '/projects/p1/complete', {
          body: { resolveUnfinishedTasks: 'markDone' },
        }),
      );

      expect(projectServiceMock.markTasksDone).toHaveBeenCalledOnceWith(unfinished);
      expect(projectServiceMock.markTasksDone).toHaveBeenCalledBefore(
        projectServiceMock.complete,
      );
    });

    it('should not touch tasks when there is nothing unfinished', async () => {
      await handle(
        createRequest('POST', '/projects/p1/complete', {
          body: { resolveUnfinishedTasks: 'markDone' },
        }),
      );

      expect(projectServiceMock.markTasksDone).not.toHaveBeenCalled();
      expect(projectServiceMock.complete).toHaveBeenCalled();
    });

    it('should reject the Inbox, archived and unknown projects', async () => {
      const inbox = await handle(
        createRequest('POST', `/projects/${INBOX_PROJECT.id}/complete`),
      );
      const archived = await handle(createRequest('POST', '/projects/archived/complete'));
      const missing = await handle(createRequest('POST', '/projects/missing/complete'));

      expect(errorCode(inbox)).toBe('INVALID_INPUT');
      expect(errorCode(archived)).toBe('INVALID_INPUT');
      expect(errorCode(missing)).toBe('PROJECT_NOT_FOUND');
      expect(projectServiceMock.complete).not.toHaveBeenCalled();
    });

    it('should validate the body', async () => {
      const wrongValue = await handle(
        createRequest('POST', '/projects/p1/complete', {
          body: { resolveUnfinishedTasks: 'delete' },
        }),
      );
      const unknownField = await handle(
        createRequest('POST', '/projects/p1/complete', { body: { force: true } }),
      );

      expect(errorCode(wrongValue)).toBe('INVALID_INPUT');
      expect(errorCode(unknownField)).toBe('UNSUPPORTED_FIELD');
      expect(projectServiceMock.getCompletionInfo).not.toHaveBeenCalled();
      expect(projectServiceMock.complete).not.toHaveBeenCalled();
    });
  });

  describe('POST /projects/:id/restore', () => {
    it('should reopen a completed project', async () => {
      patchProject('archived', { isDone: true, doneOn: 1 });

      const response = await handle(createRequest('POST', '/projects/archived/restore'));

      expect(projectServiceMock.reopen).toHaveBeenCalledOnceWith(
        'archived',
        jasmine.objectContaining({ id: 'archived' }),
      );
      expect(projectServiceMock.unarchive).not.toHaveBeenCalled();
      expect((data(response) as Project).isArchived).toBe(false);
    });

    it('should unarchive an archived project', async () => {
      const response = await handle(createRequest('POST', '/projects/archived/restore'));

      expect(projectServiceMock.unarchive).toHaveBeenCalledOnceWith('archived');
      expect(projectServiceMock.reopen).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it('should reject a project that is not archived', async () => {
      const response = await handle(createRequest('POST', '/projects/p1/restore'));

      expect(errorCode(response)).toBe('INVALID_INPUT');
      expect(projectServiceMock.unarchive).not.toHaveBeenCalled();
      expect(projectServiceMock.reopen).not.toHaveBeenCalled();
    });

    it('should return 404 for an unknown project', async () => {
      const response = await handle(createRequest('POST', '/projects/missing/restore'));

      expect(errorCode(response)).toBe('PROJECT_NOT_FOUND');
    });
  });

  it('should not own other routes', async () => {
    for (const [method, path] of [
      ['DELETE', '/projects/p1'],
      ['PUT', '/projects'],
      ['POST', '/projects/p1/archive'],
      ['GET', '/projects/p1/complete'],
      ['GET', '/tags'],
      ['GET', '/projectsx'],
    ]) {
      expect(await service.handle(createRequest(method, path)))
        .withContext(`${method} ${path}`)
        .toBeUndefined();
    }
  });
});
