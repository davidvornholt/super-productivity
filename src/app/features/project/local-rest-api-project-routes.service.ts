import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';
import { LocalRestApiRouteHandler } from '../../core/electron/local-rest-api-route-handlers';
import {
  createSuccessResponse,
  getQueryParam,
} from '../../core/electron/local-rest-api-response.util';
import { ProjectService } from './project.service';

/** Local REST API routes under `/projects`. */
@Injectable()
export class LocalRestApiProjectRoutesService implements LocalRestApiRouteHandler {
  private readonly _projectService = inject(ProjectService);

  async handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined> {
    const { method, path, requestId, query } = request;

    if (method === 'GET' && path === '/projects') {
      return this._handleListProjects(requestId, query);
    }

    return undefined;
  }

  private async _handleListProjects(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');

    let projects = await firstValueFrom(this._projectService.list$);

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      projects = projects.filter((p) => p.title.toLowerCase().includes(lowerQuery));
    }

    return createSuccessResponse(requestId, 200, projects);
  }
}
