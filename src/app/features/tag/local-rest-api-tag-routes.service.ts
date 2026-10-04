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
import { TagService } from './tag.service';

/** Local REST API routes under `/tags`. */
@Injectable()
export class LocalRestApiTagRoutesService implements LocalRestApiRouteHandler {
  private readonly _tagService = inject(TagService);

  async handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined> {
    const { method, path, requestId, query } = request;

    if (method === 'GET' && path === '/tags') {
      return this._handleListTags(requestId, query);
    }

    return undefined;
  }

  private async _handleListTags(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');

    let tags = await firstValueFrom(this._tagService.tags$);

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      tags = tags.filter((t) => t.title.toLowerCase().includes(lowerQuery));
    }

    return createSuccessResponse(requestId, 200, tags);
  }
}
