import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';
import { LocalRestApiProjectRoutesService } from './local-rest-api-project-routes.service';
import { ProjectService } from './project.service';
import { Project } from './project.model';
import { LocalRestApiRequestPayload } from '../../../../electron/shared-with-frontend/local-rest-api.model';

describe('LocalRestApiProjectRoutesService', () => {
  let service: LocalRestApiProjectRoutesService;
  let projects: Project[];

  const createRequest = (
    method: string,
    path: string,
    query: Record<string, string | string[]> = {},
  ): LocalRestApiRequestPayload => ({
    requestId: 'test-request-id',
    method,
    path,
    query,
    body: undefined,
  });

  beforeEach(() => {
    projects = [
      { id: 'p1', title: 'Work' } as Project,
      { id: 'p2', title: 'Personal' } as Project,
    ];
    const projectServiceMock = {
      get list$(): Observable<Project[]> {
        return of(projects);
      },
    };

    TestBed.configureTestingModule({
      providers: [
        LocalRestApiProjectRoutesService,
        { provide: ProjectService, useValue: projectServiceMock },
      ],
    });
    service = TestBed.inject(LocalRestApiProjectRoutesService);
  });

  describe('GET /projects', () => {
    it('should return all unarchived projects', async () => {
      const response = await service.handle(createRequest('GET', '/projects'));

      expect(response).toEqual({
        requestId: 'test-request-id',
        status: 200,
        body: { ok: true, data: projects },
      });
    });

    it('should filter projects by title, case-insensitively', async () => {
      const response = await service.handle(
        createRequest('GET', '/projects', { query: 'WORK' }),
      );

      expect(response?.body).toEqual({ ok: true, data: [projects[0]] });
    });
  });

  it('should not own other routes', async () => {
    expect(await service.handle(createRequest('POST', '/projects'))).toBeUndefined();
    expect(await service.handle(createRequest('GET', '/projects/p1'))).toBeUndefined();
    expect(await service.handle(createRequest('GET', '/tags'))).toBeUndefined();
  });
});
