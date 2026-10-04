/* eslint-disable @typescript-eslint/naming-convention */
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { LocalRestApiTaskTimeRoutesService } from './local-rest-api-task-time-routes.service';
import { TaskService } from './task.service';
import { Task, DEFAULT_TASK } from './task.model';
import { DateService } from '../../core/date/date.service';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';

describe('LocalRestApiTaskTimeRoutesService', () => {
  let service: LocalRestApiTaskTimeRoutesService;
  let taskServiceMock: jasmine.SpyObj<TaskService>;
  let tasks: Record<string, Task>;

  const createTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    ...DEFAULT_TASK,
    id,
    title: `Task ${id}`,
    projectId: 'p1',
    ...overrides,
  });

  const putTime = (taskId: string, body: unknown): LocalRestApiRequestPayload => ({
    requestId: 'test-request-id',
    method: 'PUT',
    path: `/tasks/${taskId}/time`,
    query: {},
    body,
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

  beforeEach(() => {
    tasks = {
      t1: createTask('t1', {
        timeSpentOnDay: { '2026-10-01': 60000, '2026-10-02': 120000 },
        timeSpent: 180000,
      }),
      parent: createTask('parent', { subTaskIds: ['sub'] }),
      sub: createTask('sub', { parentId: 'parent' }),
    };

    taskServiceMock = jasmine.createSpyObj<TaskService>('TaskService', [
      'getByIdOnce$',
      'update',
    ]);
    // Like the store's entity lookup: a plain-object map, prototype included.
    taskServiceMock.getByIdOnce$.and.callFake((id: string) =>
      of((tasks as Record<string, Task>)[id]),
    );
    taskServiceMock.update.and.callFake((id: string, changes: Partial<Task>) => {
      tasks = { ...tasks, [id]: { ...tasks[id], ...changes } };
    });

    TestBed.configureTestingModule({
      providers: [
        LocalRestApiTaskTimeRoutesService,
        { provide: TaskService, useValue: taskServiceMock },
        {
          provide: DateService,
          useValue: { todayStr: (): string => '2026-10-04' },
        },
      ],
    });
    service = TestBed.inject(LocalRestApiTaskTimeRoutesService);
  });

  it('should set the time of a day and keep the other days', async () => {
    const response = await handle(putTime('t1', { date: '2026-10-02', ms: 900000 }));

    expect(taskServiceMock.update).toHaveBeenCalledOnceWith('t1', {
      timeSpentOnDay: { '2026-10-01': 60000, '2026-10-02': 900000 },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: jasmine.objectContaining({
        id: 't1',
        timeSpentOnDay: { '2026-10-01': 60000, '2026-10-02': 900000 },
      }),
    });
  });

  it('should add a new day', async () => {
    await handle(putTime('t1', { date: '2026-09-30', ms: 1000 }));

    expect(taskServiceMock.update).toHaveBeenCalledOnceWith('t1', {
      timeSpentOnDay: { '2026-10-01': 60000, '2026-10-02': 120000, '2026-09-30': 1000 },
    });
  });

  it("should default to the app's current day", async () => {
    await handle(putTime('t1', { ms: 5000 }));

    expect(taskServiceMock.update.calls.mostRecent().args[1].timeSpentOnDay).toEqual(
      jasmine.objectContaining({ '2026-10-04': 5000 }),
    );
  });

  it('should remove the day when ms is 0, as the time dialog does', async () => {
    await handle(putTime('t1', { date: '2026-10-01', ms: 0 }));

    expect(taskServiceMock.update).toHaveBeenCalledOnceWith('t1', {
      timeSpentOnDay: { '2026-10-02': 120000 },
    });
  });

  it('should not dispatch when the value does not change', async () => {
    for (const body of [
      { date: '2026-10-01', ms: 60000 },
      { date: '2026-09-01', ms: 0 },
    ]) {
      const response = await handle(putTime('t1', body));

      expect(response.status).withContext(JSON.stringify(body)).toBe(200);
    }
    expect(taskServiceMock.update).not.toHaveBeenCalled();
  });

  it('should set the time of a subtask', async () => {
    await handle(putTime('sub', { date: '2026-10-01', ms: 1000 }));

    expect(taskServiceMock.update).toHaveBeenCalledOnceWith('sub', {
      timeSpentOnDay: { '2026-10-01': 1000 },
    });
  });

  it('should reject a task with subtasks', async () => {
    const response = await handle(putTime('parent', { date: '2026-10-01', ms: 1000 }));

    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe('INVALID_INPUT');
    expect(taskServiceMock.update).not.toHaveBeenCalled();
  });

  it('should return 404 TASK_NOT_FOUND for unknown and prototype ids', async () => {
    for (const id of ['missing', '__proto__', 'constructor']) {
      const response = await handle(putTime(id, { date: '2026-10-01', ms: 1000 }));

      expect(response.status).withContext(id).toBe(404);
      expect(errorCode(response)).withContext(id).toBe('TASK_NOT_FOUND');
    }
    expect(taskServiceMock.update).not.toHaveBeenCalled();
  });

  it('should validate before writing', async () => {
    const cases: [unknown, string][] = [
      [undefined, 'INVALID_INPUT'],
      [[], 'INVALID_INPUT'],
      [{}, 'INVALID_INPUT'],
      [{ ms: '1000' }, 'INVALID_INPUT'],
      [{ ms: -1 }, 'INVALID_INPUT'],
      [{ ms: 1.5 }, 'INVALID_INPUT'],
      [{ ms: 2 ** 53 }, 'INVALID_INPUT'],
      [{ ms: 1000, date: 20261001 }, 'INVALID_INPUT'],
      [{ ms: 1000, date: '2026-02-30' }, 'INVALID_INPUT'],
      [{ ms: 1000, date: '01.10.2026' }, 'INVALID_INPUT'],
      [{ ms: 1000, date: '__proto__' }, 'INVALID_INPUT'],
      [{ ms: 1000, timeSpent: 5 }, 'UNSUPPORTED_FIELD'],
    ];
    for (const [body, code] of cases) {
      const response = await handle(putTime('t1', body));

      expect(response.status).withContext(JSON.stringify(body)).toBe(400);
      expect(errorCode(response)).withContext(JSON.stringify(body)).toBe(code);
    }
    expect(taskServiceMock.update).not.toHaveBeenCalled();
  });

  it('should not own other routes', async () => {
    for (const [method, path] of [
      ['GET', '/tasks/t1/time'],
      ['POST', '/tasks/t1/time'],
      ['PUT', '/tasks/t1'],
      ['PUT', '/tasks/t1/time/2026-10-01'],
      ['PUT', '/projects/p1/time'],
    ]) {
      const request = { ...putTime('t1', { ms: 1 }), method, path };

      expect(await service.handle(request))
        .withContext(`${method} ${path}`)
        .toBeUndefined();
    }
  });
});
