import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';
import { LocalRestApiTagRoutesService } from './local-rest-api-tag-routes.service';
import { TagService } from './tag.service';
import { Tag } from './tag.model';
import { LocalRestApiRequestPayload } from '../../../../electron/shared-with-frontend/local-rest-api.model';

describe('LocalRestApiTagRoutesService', () => {
  let service: LocalRestApiTagRoutesService;
  let tags: Tag[];

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
    tags = [
      { id: 't1', title: 'Urgent' } as Tag,
      { id: 't2', title: 'Important' } as Tag,
    ];
    const tagServiceMock = {
      get tags$(): Observable<Tag[]> {
        return of(tags);
      },
    };

    TestBed.configureTestingModule({
      providers: [
        LocalRestApiTagRoutesService,
        { provide: TagService, useValue: tagServiceMock },
      ],
    });
    service = TestBed.inject(LocalRestApiTagRoutesService);
  });

  describe('GET /tags', () => {
    it('should return all tags', async () => {
      const response = await service.handle(createRequest('GET', '/tags'));

      expect(response).toEqual({
        requestId: 'test-request-id',
        status: 200,
        body: { ok: true, data: tags },
      });
    });

    it('should filter tags by title, case-insensitively', async () => {
      const response = await service.handle(
        createRequest('GET', '/tags', { query: ['urgent', 'ignored'] }),
      );

      expect(response?.body).toEqual({ ok: true, data: [tags[0]] });
    });
  });

  it('should not own other routes', async () => {
    expect(await service.handle(createRequest('POST', '/tags'))).toBeUndefined();
    expect(await service.handle(createRequest('GET', '/tags/t1'))).toBeUndefined();
    expect(await service.handle(createRequest('GET', '/projects'))).toBeUndefined();
  });
});
