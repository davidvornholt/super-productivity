import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import typia, { IValidation } from 'typia';
import {
  LocalRestApiRequestPayload,
  LocalRestApiResponsePayload,
} from '../../../../electron/shared-with-frontend/local-rest-api.model';
import {
  LocalRestApiResult,
  parseLocalRestApiBody,
} from '../../core/electron/local-rest-api-body';
import { LocalRestApiFeatureRoutes } from '../../core/electron/local-rest-api-feature-routes';
import {
  createErrorResponse,
  createSuccessResponse,
} from '../../core/electron/local-rest-api-response';
import { DEFAULT_TAG_COLOR } from '../work-context/work-context.const';
import { TODAY_TAG } from './tag.const';
import { Tag } from './tag.model';
import { TagService } from './tag.service';

interface UpdateTagFields {
  title?: string;
  icon?: string | null;
  color?: string;
}

interface CreateTagFields extends UpdateTagFields {
  title: string;
}

const WRITABLE_KEYS: ReadonlySet<string> = new Set(['title', 'icon', 'color']);

/** The format the tag settings dialog's color picker produces. */
const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/i;

/**
 * Trims and drops leading '#', which a user types out of habit: the task
 * editor's tag field and short syntax strip it too, so a tag created here
 * matches one typed as `#errands`.
 */
const normalizeTagTitle = (title: string): string =>
  title.trim().replace(/^#+/, '').trim();

/**
 * Local REST API routes under `/tags`. `GET /tags` is served by the core
 * handler before feature routes run, so this handles `GET /tags/:id` and the
 * writes.
 */
@Injectable()
export class LocalRestApiTagRoutesService implements LocalRestApiFeatureRoutes {
  private readonly _tagService = inject(TagService);

  async handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined> {
    const { method, requestId, body } = request;
    const segments = request.path.split('/').filter(Boolean);
    if (segments[0] !== 'tags') {
      return undefined;
    }

    if (segments.length === 1 && method === 'POST') {
      return this._handleCreate(requestId, body);
    }

    if (segments.length === 2) {
      const tagId = segments[1];
      if (method === 'GET') {
        return this._handleGet(requestId, tagId);
      }
      if (method === 'PATCH') {
        return this._handleUpdate(requestId, tagId, body);
      }
      if (method === 'DELETE') {
        return this._handleDelete(requestId, tagId);
      }
    }

    return undefined;
  }

  private async _handleGet(
    requestId: string,
    tagId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const tag = await this._getTag(tagId);
    if (!tag) {
      return this._tagNotFound(requestId);
    }
    return createSuccessResponse(requestId, 200, tag);
  }

  private async _handleCreate(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseBody(requestId, body, (b) =>
      typia.validate<CreateTagFields>(b),
    );
    if (!parsed.ok) {
      return parsed.response;
    }
    const { title, icon, color } = parsed.value;

    // The task editor's tag field reuses a tag of the same title instead of
    // adding a second one; a caller that wants that gets the id from here.
    const existing = await this._findTagByTitle(title);
    if (existing) {
      return this._tagExists(requestId, existing);
    }

    // Like the create-tag dialog: without a color, addTag picks a preset one.
    // The theme keeps its default primary, which the tag color overrides.
    const tagId = this._tagService.addTag({
      title,
      ...(icon !== undefined ? { icon } : {}),
      ...(color !== undefined ? { color } : {}),
    });

    return createSuccessResponse(requestId, 201, await this._getTag(tagId));
  }

  private async _handleUpdate(
    requestId: string,
    tagId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    // The work-context menu offers no rename for Today either.
    if (tagId === TODAY_TAG.id) {
      return this._todayTagRefused(requestId, 'modified');
    }

    const parsed = this._parseBody(requestId, body, (b) =>
      typia.validate<UpdateTagFields>(b),
    );
    if (!parsed.ok) {
      return parsed.response;
    }

    const tag = await this._getTag(tagId);
    if (!tag) {
      return this._tagNotFound(requestId);
    }

    if (parsed.value.title !== undefined) {
      const existing = await this._findTagByTitle(parsed.value.title);
      if (existing && existing.id !== tagId) {
        return this._tagExists(requestId, existing);
      }
    }

    if (Object.keys(parsed.value).length > 0) {
      // The caller gets the result in the response; the app's "Tag updated"
      // snack would only interrupt whoever is using it.
      this._tagService.updateTag(tagId, this._withThemePrimary(tag, parsed.value), true);
    }

    return createSuccessResponse(requestId, 200, await this._getTag(tagId));
  }

  private async _handleDelete(
    requestId: string,
    tagId: string,
  ): Promise<LocalRestApiResponsePayload> {
    // Only Today is protected: the work-context menu offers "Delete tag" for
    // every other tag, the board tags (urgent, important, in-progress)
    // included, and a board recreates those on demand.
    if (tagId === TODAY_TAG.id) {
      return this._todayTagRefused(requestId, 'deleted');
    }

    const tag = await this._getTag(tagId);
    if (!tag) {
      return this._tagNotFound(requestId);
    }

    // Also removes the tag from all tasks, active and archived, as the UI's
    // "Delete tag" does.
    this._tagService.deleteTag(tagId);

    return createSuccessResponse(requestId, 200, { deleted: true, id: tagId });
  }

  /**
   * Like the tag settings dialog: theme.primary follows a new color unless the
   * user picked a different primary color on purpose.
   */
  private _withThemePrimary(tag: Tag, changes: UpdateTagFields): Partial<Tag> {
    const { color } = changes;
    const primary = tag.theme?.primary;
    const isPrimaryCustomized = primary !== DEFAULT_TAG_COLOR && primary !== tag.color;
    if (color === undefined || isPrimaryCustomized) {
      return changes;
    }
    return { ...changes, theme: { ...tag.theme, primary: color } };
  }

  /**
   * Rejects a non-object body and keys other than title, icon and color, then
   * type-checks the rest. A title, where given, is normalized like one typed
   * in the app and must not end up empty. A color must be a `#rrggbb` hex
   * color and is stored in lower case, as the color picker stores it.
   */
  private _parseBody<T extends UpdateTagFields>(
    requestId: string,
    body: unknown,
    validate: (body: Record<string, unknown>) => IValidation<T>,
  ): LocalRestApiResult<T> {
    const parsed = parseLocalRestApiBody(requestId, body, WRITABLE_KEYS, validate, 'tag');
    if (!parsed.ok) {
      return parsed;
    }
    let { value } = parsed;
    if (value.title !== undefined) {
      const title = normalizeTagTitle(value.title);
      if (!title) {
        return {
          ok: false,
          response: this._invalid(
            requestId,
            'title must be a non-empty string, not counting a leading #',
          ),
        };
      }
      value = { ...value, title };
    }
    if (value.color !== undefined) {
      if (!HEX_COLOR_REGEX.test(value.color)) {
        return {
          ok: false,
          response: this._invalid(requestId, 'color must be a #rrggbb hex color'),
        };
      }
      value = { ...value, color: value.color.toLowerCase() };
    }
    return { ok: true, value };
  }

  /**
   * Case-insensitive, as short syntax matches `#Errands` to a tag "errands".
   */
  private async _findTagByTitle(title: string): Promise<Tag | undefined> {
    const wanted = title.toLowerCase();
    const tags = await firstValueFrom(this._tagService.tags$);
    return tags.find((tag) => tag.title.toLowerCase() === wanted);
  }

  private _tagExists(requestId: string, existing: Tag): LocalRestApiResponsePayload {
    return createErrorResponse(
      requestId,
      409,
      'TAG_EXISTS',
      'A tag with this title already exists',
      { id: existing.id, title: existing.title },
    );
  }

  /**
   * By id equality over the list: the entity map lookup throws for unknown
   * ids and resolves ids like `__proto__` to prototype members.
   */
  private async _getTag(tagId: string): Promise<Tag | undefined> {
    const tags = await firstValueFrom(this._tagService.tags$);
    return tags.find((tag) => tag.id === tagId);
  }

  private _todayTagRefused(
    requestId: string,
    verb: 'modified' | 'deleted',
  ): LocalRestApiResponsePayload {
    return createErrorResponse(
      requestId,
      400,
      'UNSUPPORTED_FIELD',
      `The Today tag is virtual and cannot be ${verb}`,
    );
  }

  private _tagNotFound(requestId: string): LocalRestApiResponsePayload {
    return createErrorResponse(requestId, 404, 'TAG_NOT_FOUND', 'Tag not found');
  }

  private _invalid(
    requestId: string,
    message: string,
    details?: unknown,
  ): LocalRestApiResponsePayload {
    return createErrorResponse(requestId, 400, 'INVALID_INPUT', message, details);
  }
}
