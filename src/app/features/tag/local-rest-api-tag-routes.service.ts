import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import typia from 'typia';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';
import { LocalRestApiRouteHandler } from '../../core/electron/local-rest-api-route-handlers';
import {
  createErrorResponse,
  createSuccessResponse,
  getPathSegments,
  getQueryParam,
  isRecord,
  toFieldTypeErrors,
} from '../../core/electron/local-rest-api-response.util';
import {
  getUnsupportedFields,
  isHexColor,
} from '../work-context/local-rest-api-work-context-fields';
import { DEFAULT_TAG_COLOR } from '../work-context/work-context.const';
import { TagService } from './tag.service';
import { Tag } from './tag.model';

/**
 * The fields the create-tag and tag settings dialogs write. `taskIds` is
 * ordering/membership state and only changes through task actions.
 */
const WRITABLE_TAG_FIELDS: ReadonlySet<string> = new Set(['title', 'icon', 'color']);

interface WritableTagFields {
  title?: string;
  icon?: string | null;
  color?: string;
}

type BodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: LocalRestApiResponsePayload };

/** Local REST API routes under `/tags`. */
@Injectable()
export class LocalRestApiTagRoutesService implements LocalRestApiRouteHandler {
  private readonly _tagService = inject(TagService);

  async handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined> {
    const { method, requestId, query, body } = request;
    const segments = getPathSegments(request.path);
    if (segments[0] !== 'tags') {
      return undefined;
    }

    if (segments.length === 1) {
      if (method === 'GET') {
        return this._handleListTags(requestId, query);
      }
      if (method === 'POST') {
        return this._handleCreateTag(requestId, body);
      }
      return undefined;
    }

    if (segments.length === 2) {
      const tagId = segments[1];
      if (method === 'GET') {
        return this._handleGetTag(requestId, tagId);
      }
      if (method === 'PATCH') {
        return this._handleUpdateTag(requestId, tagId, body);
      }
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

  private async _handleGetTag(
    requestId: string,
    tagId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const tag = await this._getTag(tagId);
    if (!tag) {
      return this._tagNotFound(requestId);
    }
    return createSuccessResponse(requestId, 200, tag);
  }

  private async _handleCreateTag(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseTagFields(requestId, body);
    if (!parsed.ok) {
      return parsed.response;
    }
    if (parsed.value.title === undefined) {
      return this._invalid(requestId, 'Tag title must be a non-empty string').response;
    }

    // Same as the create-tag dialog: TagService fills in the defaults and a
    // random preset color when none is given.
    const tagId = this._tagService.addTag(parsed.value);

    return createSuccessResponse(requestId, 201, await this._getTag(tagId));
  }

  private async _handleUpdateTag(
    requestId: string,
    tagId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseTagFields(requestId, body);
    if (!parsed.ok) {
      return parsed.response;
    }

    const tag = await this._getTag(tagId);
    if (!tag) {
      return this._tagNotFound(requestId);
    }

    const { color, ...rest } = parsed.value;
    // Like the tag settings dialog: theme.primary follows the tag color unless
    // the user picked a different primary color on purpose.
    const primary = tag.theme?.primary;
    const isPrimaryCustomized = primary !== DEFAULT_TAG_COLOR && primary !== tag.color;
    const changes: Partial<Tag> = {
      ...rest,
      ...(color !== undefined ? { color } : {}),
      ...(color !== undefined && !isPrimaryCustomized
        ? { theme: { ...tag.theme, primary: color } }
        : {}),
    };
    if (Object.keys(changes).length > 0) {
      this._tagService.updateTag(tagId, changes);
    }

    return createSuccessResponse(requestId, 200, await this._getTag(tagId));
  }

  private _parseTagFields(
    requestId: string,
    body: unknown,
  ): BodyResult<WritableTagFields> {
    if (!isRecord(body)) {
      return this._invalid(requestId, 'Request body must be a JSON object');
    }

    const unsupported = getUnsupportedFields(body, WRITABLE_TAG_FIELDS);
    if (unsupported.length > 0) {
      return {
        ok: false,
        response: createErrorResponse(
          requestId,
          400,
          'UNSUPPORTED_FIELD',
          `Field(s) cannot be set through this endpoint: ${unsupported.join(', ')}`,
          { fields: unsupported },
        ),
      };
    }

    const validation = typia.validate<WritableTagFields>(body);
    if (!validation.success) {
      return this._invalid(
        requestId,
        'One or more tag fields have an invalid type',
        toFieldTypeErrors(validation.errors),
      );
    }

    const fields = validation.data;
    if (fields.color !== undefined && !isHexColor(fields.color)) {
      return this._invalid(requestId, 'color must be a #rgb or #rrggbb color');
    }
    if (fields.title !== undefined) {
      const title = fields.title.trim();
      if (!title) {
        return this._invalid(requestId, 'Tag title must be a non-empty string');
      }
      return { ok: true, value: { ...fields, title } };
    }
    return { ok: true, value: fields };
  }

  /** By id equality, so ids like `__proto__` can't resolve to prototype members. */
  private async _getTag(tagId: string): Promise<Tag | undefined> {
    const tags = await firstValueFrom(this._tagService.tags$);
    return tags.find((tag) => tag.id === tagId);
  }

  private _tagNotFound(requestId: string): LocalRestApiResponsePayload {
    return createErrorResponse(requestId, 404, 'TAG_NOT_FOUND', 'Tag not found');
  }

  private _invalid(
    requestId: string,
    message: string,
    details?: unknown,
  ): { ok: false; response: LocalRestApiResponsePayload } {
    return {
      ok: false,
      response: createErrorResponse(requestId, 400, 'INVALID_INPUT', message, details),
    };
  }
}
