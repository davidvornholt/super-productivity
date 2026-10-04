import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';
import { LocalRestApiNoteRoutesService } from './local-rest-api-note-routes.service';
import { NoteService } from './note.service';
import { Note } from './note.model';
import { ProjectService } from '../project/project.service';
import { Project } from '../project/project.model';
import { DEFAULT_PROJECT } from '../project/project.const';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';

describe('LocalRestApiNoteRoutesService', () => {
  let service: LocalRestApiNoteRoutesService;
  let noteServiceMock: jasmine.SpyObj<NoteService>;
  let notes: Note[];
  let activeProjects: Project[];

  const createNote = (id: string, overrides: Partial<Note> = {}): Note => ({
    id,
    projectId: 'p1',
    isPinnedToToday: false,
    content: `Note ${id}`,
    created: 1,
    modified: 1,
    ...overrides,
  });

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

  const expectNoWrite = (): void => {
    expect(noteServiceMock.add).not.toHaveBeenCalled();
    expect(noteServiceMock.update).not.toHaveBeenCalled();
    expect(noteServiceMock.moveToOtherProject).not.toHaveBeenCalled();
    expect(noteServiceMock.remove).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    notes = [
      createNote('n1', { content: 'Shopping list' }),
      createNote('n2', { projectId: 'p2' }),
      createNote('n3', { projectId: null, isPinnedToToday: true }),
    ];
    activeProjects = [
      { ...DEFAULT_PROJECT, id: 'p1', title: 'One' },
      { ...DEFAULT_PROJECT, id: 'p2', title: 'Two' },
    ];

    noteServiceMock = jasmine.createSpyObj<NoteService>('NoteService', [
      'add',
      'update',
      'remove',
      'moveToOtherProject',
    ]);
    Object.defineProperty(noteServiceMock, 'notes$', {
      get: (): Observable<Note[]> => of(notes),
    });
    noteServiceMock.add.and.callFake((note: Partial<Note> = {}) => {
      notes = [createNote(note.id as string, note), ...notes];
    });
    noteServiceMock.update.and.callFake((id: string, changes: Partial<Note>) => {
      notes = notes.map((n) => (n.id === id ? { ...n, ...changes } : n));
    });
    noteServiceMock.moveToOtherProject.and.callFake(
      (note: Note, targetProjectId: string) => {
        notes = notes.map((n) =>
          n.id === note.id ? { ...n, projectId: targetProjectId } : n,
        );
      },
    );
    noteServiceMock.remove.and.callFake((note: Note) => {
      notes = notes.filter((n) => n.id !== note.id);
    });

    const projectServiceMock = {} as ProjectService;
    Object.defineProperty(projectServiceMock, 'list$', {
      get: (): Observable<Project[]> => of(activeProjects),
    });

    TestBed.configureTestingModule({
      providers: [
        LocalRestApiNoteRoutesService,
        { provide: NoteService, useValue: noteServiceMock },
        { provide: ProjectService, useValue: projectServiceMock },
      ],
    });
    service = TestBed.inject(LocalRestApiNoteRoutesService);
  });

  describe('GET /notes', () => {
    it('should return all notes', async () => {
      const response = await handle(createRequest('GET', '/notes'));

      expect(response).toEqual({
        requestId: 'test-request-id',
        status: 200,
        body: { ok: true, data: notes },
      });
    });

    it('should filter notes by project', async () => {
      const response = await handle(
        createRequest('GET', '/notes', { query: { projectId: ['p2', 'ignored'] } }),
      );

      expect((data(response) as Note[]).map((n) => n.id)).toEqual(['n2']);
    });
  });

  describe('GET /notes/:id', () => {
    it('should return the note', async () => {
      const response = await handle(createRequest('GET', '/notes/n1'));

      expect(response.status).toBe(200);
      expect((data(response) as Note).content).toBe('Shopping list');
    });

    it('should return 404 NOTE_NOT_FOUND for unknown and prototype ids', async () => {
      for (const id of ['missing', '__proto__', 'constructor']) {
        const response = await handle(createRequest('GET', `/notes/${id}`));

        expect(response.status).withContext(id).toBe(404);
        expect(errorCode(response)).withContext(id).toBe('NOTE_NOT_FOUND');
      }
    });
  });

  describe('POST /notes', () => {
    it('should create a note in the given project, independent of the UI context', async () => {
      const response = await handle(
        createRequest('POST', '/notes', { body: { content: 'Idea', projectId: 'p2' } }),
      );

      const [note, isPreventFocus] = noteServiceMock.add.calls.mostRecent().args;
      expect(note).toEqual({
        id: jasmine.any(String),
        content: 'Idea',
        projectId: 'p2',
        isPinnedToToday: false,
      });
      expect(isPreventFocus).toBeTrue();
      expect(response.status).toBe(201);
      expect(data(response)).toEqual(jasmine.objectContaining({ id: note?.id }));
    });

    it('should create a note pinned to Today without a project', async () => {
      await handle(
        createRequest('POST', '/notes', {
          body: { content: 'Today only', isPinnedToToday: true },
        }),
      );

      expect(noteServiceMock.add.calls.mostRecent().args[0]).toEqual(
        jasmine.objectContaining({ projectId: null, isPinnedToToday: true }),
      );
    });

    it('should reject a note that would be shown nowhere', async () => {
      for (const body of [
        { content: 'x' },
        { content: 'x', projectId: null },
        { content: 'x', isPinnedToToday: false },
      ]) {
        const response = await handle(createRequest('POST', '/notes', { body }));

        expect(response.status).withContext(JSON.stringify(body)).toBe(400);
        expect(errorCode(response))
          .withContext(JSON.stringify(body))
          .toBe('INVALID_INPUT');
      }
      expectNoWrite();
    });

    it('should return 404 PROJECT_NOT_FOUND for an unknown or archived project', async () => {
      for (const projectId of ['archived-or-missing', '__proto__']) {
        const response = await handle(
          createRequest('POST', '/notes', { body: { content: 'x', projectId } }),
        );

        expect(response.status).withContext(projectId).toBe(404);
        expect(errorCode(response)).withContext(projectId).toBe('PROJECT_NOT_FOUND');
      }
      expectNoWrite();
    });

    it('should validate before creating', async () => {
      const cases: [unknown, string][] = [
        [undefined, 'INVALID_INPUT'],
        ['text', 'INVALID_INPUT'],
        [[], 'INVALID_INPUT'],
        [{ projectId: 'p1' }, 'INVALID_INPUT'],
        [{ content: '   ', projectId: 'p1' }, 'INVALID_INPUT'],
        [{ content: 5, projectId: 'p1' }, 'INVALID_INPUT'],
        [{ content: 'x', projectId: 5 }, 'INVALID_INPUT'],
        [{ content: 'x', projectId: 'p1', isPinnedToToday: 'yes' }, 'INVALID_INPUT'],
        [{ content: 'x', projectId: 'p1', id: 'mine' }, 'UNSUPPORTED_FIELD'],
        [{ content: 'x', projectId: 'p1', isLock: true }, 'UNSUPPORTED_FIELD'],
      ];
      for (const [body, code] of cases) {
        const response = await handle(createRequest('POST', '/notes', { body }));

        expect(response.status).withContext(JSON.stringify(body)).toBe(400);
        expect(errorCode(response)).withContext(JSON.stringify(body)).toBe(code);
      }
      expectNoWrite();
    });

    it('should list the unsupported fields in the error details', async () => {
      const response = await handle(
        createRequest('POST', '/notes', {
          body: { content: 'x', projectId: 'p1', created: 0, imgUrl: 'a' },
        }),
      );

      expect(response.body).toEqual({
        ok: false,
        error: jasmine.objectContaining({
          code: 'UNSUPPORTED_FIELD',
          details: { fields: ['created', 'imgUrl'] },
        }),
      });
    });
  });

  describe('PATCH /notes/:id', () => {
    it('should update content and pin state in one update', async () => {
      const response = await handle(
        createRequest('PATCH', '/notes/n1', {
          body: { content: 'New text', isPinnedToToday: true },
        }),
      );

      expect(noteServiceMock.update).toHaveBeenCalledOnceWith('n1', {
        content: 'New text',
        isPinnedToToday: true,
      });
      expect(noteServiceMock.moveToOtherProject).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect((data(response) as Note).content).toBe('New text');
    });

    it('should move the note to another project', async () => {
      const original = notes[0];

      const response = await handle(
        createRequest('PATCH', '/notes/n1', { body: { projectId: 'p2' } }),
      );

      expect(noteServiceMock.moveToOtherProject).toHaveBeenCalledOnceWith(original, 'p2');
      expect(noteServiceMock.update).not.toHaveBeenCalled();
      expect((data(response) as Note).projectId).toBe('p2');
    });

    it('should move a Today-only note into a project', async () => {
      await handle(createRequest('PATCH', '/notes/n3', { body: { projectId: 'p1' } }));

      expect(noteServiceMock.moveToOtherProject).toHaveBeenCalledOnceWith(
        jasmine.objectContaining({ id: 'n3' }),
        'p1',
      );
    });

    it('should not dispatch when nothing changes', async () => {
      for (const body of [{}, { projectId: 'p1' }]) {
        const response = await handle(createRequest('PATCH', '/notes/n1', { body }));

        expect(response.status).withContext(JSON.stringify(body)).toBe(200);
      }
      expectNoWrite();
    });

    it('should not unpin a note that has no project', async () => {
      const response = await handle(
        createRequest('PATCH', '/notes/n3', { body: { isPinnedToToday: false } }),
      );

      expect(response.status).toBe(400);
      expect(errorCode(response)).toBe('INVALID_INPUT');
      expectNoWrite();
    });

    it('should allow unpinning while moving into a project', async () => {
      const response = await handle(
        createRequest('PATCH', '/notes/n3', {
          body: { isPinnedToToday: false, projectId: 'p1' },
        }),
      );

      expect(response.status).toBe(200);
      expect(noteServiceMock.update).toHaveBeenCalledOnceWith('n3', {
        isPinnedToToday: false,
      });
      expect(noteServiceMock.moveToOtherProject).toHaveBeenCalledTimes(1);
    });

    it('should return 404 PROJECT_NOT_FOUND for an unknown or archived target', async () => {
      const response = await handle(
        createRequest('PATCH', '/notes/n1', {
          body: { content: 'x', projectId: 'archived-or-missing' },
        }),
      );

      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('PROJECT_NOT_FOUND');
      expectNoWrite();
    });

    it('should return 404 NOTE_NOT_FOUND for an unknown note', async () => {
      const response = await handle(
        createRequest('PATCH', '/notes/__proto__', { body: { content: 'x' } }),
      );

      expect(errorCode(response)).toBe('NOTE_NOT_FOUND');
      expectNoWrite();
    });

    it('should validate before updating', async () => {
      const cases: [unknown, string][] = [
        ['x', 'INVALID_INPUT'],
        [{ content: '' }, 'INVALID_INPUT'],
        [{ content: null }, 'INVALID_INPUT'],
        [{ projectId: null }, 'INVALID_INPUT'],
        [{ isPinnedToToday: 1 }, 'INVALID_INPUT'],
        [{ modified: 5 }, 'UNSUPPORTED_FIELD'],
        [{ backgroundColor: '#fff' }, 'UNSUPPORTED_FIELD'],
      ];
      for (const [body, code] of cases) {
        const response = await handle(createRequest('PATCH', '/notes/n1', { body }));

        expect(response.status).withContext(JSON.stringify(body)).toBe(400);
        expect(errorCode(response)).withContext(JSON.stringify(body)).toBe(code);
      }
      expectNoWrite();
    });
  });

  describe('DELETE /notes/:id', () => {
    it('should delete the note through NoteService', async () => {
      const original = notes[1];

      const response = await handle(createRequest('DELETE', '/notes/n2'));

      expect(noteServiceMock.remove).toHaveBeenCalledOnceWith(original);
      expect(response).toEqual({
        requestId: 'test-request-id',
        status: 200,
        body: { ok: true, data: { deleted: true, id: 'n2' } },
      });
    });

    it('should return 404 NOTE_NOT_FOUND for an unknown note', async () => {
      const response = await handle(createRequest('DELETE', '/notes/missing'));

      expect(response.status).toBe(404);
      expect(errorCode(response)).toBe('NOTE_NOT_FOUND');
      expectNoWrite();
    });
  });

  it('should not own other routes', async () => {
    for (const [method, path] of [
      ['PUT', '/notes'],
      ['DELETE', '/notes'],
      ['PUT', '/notes/n1'],
      ['GET', '/notes/n1/content'],
      ['GET', '/projects'],
      ['GET', '/notesx'],
    ]) {
      expect(await service.handle(createRequest(method, path)))
        .withContext(`${method} ${path}`)
        .toBeUndefined();
    }
  });
});
