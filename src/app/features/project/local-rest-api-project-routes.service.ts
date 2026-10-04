import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
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
  hasOwn,
  isRecord,
  toFieldTypeErrors,
} from '../../core/electron/local-rest-api-response.util';
import { DateService } from '../../core/date/date.service';
import { getRandomWorkContextColor } from '../../ui/work-context-color';
import {
  getUnsupportedFields,
  isHexColor,
} from '../work-context/local-rest-api-work-context-fields';
import { ProjectService } from './project.service';
import { Project } from './project.model';
import { DEFAULT_PROJECT, INBOX_PROJECT } from './project.const';
import { selectAllProjects } from './store/project.selectors';

/**
 * The fields the project settings dialog writes. Relational and lifecycle
 * fields (`taskIds`, `noteIds`, `isArchived`, `isDone`, ...) only change
 * through their own actions, so they are not writable here.
 */
const WRITABLE_PROJECT_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'icon',
  'isEnableBacklog',
  'isHiddenFromMenu',
  'theme',
]);

/** Only the color of the theme; the rest of it stays a settings-dialog concern. */
const WRITABLE_PROJECT_THEME_FIELDS: ReadonlySet<string> = new Set(['primary']);

interface WritableProjectFields {
  title?: string;
  icon?: string | null;
  isEnableBacklog?: boolean;
  isHiddenFromMenu?: boolean;
  theme?: { primary?: string };
}

const RESOLVE_UNFINISHED_TASKS_CHOICES = ['inbox', 'markDone'] as const;
type ResolveUnfinishedTasks = (typeof RESOLVE_UNFINISHED_TASKS_CHOICES)[number];

const isResolveUnfinishedTasks = (value: unknown): value is ResolveUnfinishedTasks =>
  RESOLVE_UNFINISHED_TASKS_CHOICES.some((choice) => choice === value);

type BodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: LocalRestApiResponsePayload };

/** Local REST API routes under `/projects`. */
@Injectable()
export class LocalRestApiProjectRoutesService implements LocalRestApiRouteHandler {
  private readonly _projectService = inject(ProjectService);
  private readonly _dateService = inject(DateService);
  private readonly _store = inject(Store);

  async handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined> {
    const { method, requestId, query, body } = request;
    const segments = getPathSegments(request.path);
    if (segments[0] !== 'projects') {
      return undefined;
    }

    if (segments.length === 1) {
      if (method === 'GET') {
        return this._handleListProjects(requestId, query);
      }
      if (method === 'POST') {
        return this._handleCreateProject(requestId, body);
      }
      return undefined;
    }

    const projectId = segments[1];
    if (segments.length === 2) {
      if (method === 'GET') {
        return this._handleGetProject(requestId, projectId);
      }
      if (method === 'PATCH') {
        return this._handleUpdateProject(requestId, projectId, body);
      }
      return undefined;
    }

    if (segments.length === 3 && method === 'POST') {
      if (segments[2] === 'complete') {
        return this._handleCompleteProject(requestId, projectId, body);
      }
      if (segments[2] === 'restore') {
        return this._handleRestoreProject(requestId, projectId);
      }
    }

    return undefined;
  }

  private async _handleListProjects(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const queryText = getQueryParam(query, 'query');
    const includeArchived = getQueryParam(query, 'includeArchived') === 'true';

    let projects = includeArchived
      ? await firstValueFrom(this._store.select(selectAllProjects))
      : await firstValueFrom(this._projectService.list$);

    if (queryText) {
      const lowerQuery = queryText.toLowerCase();
      projects = projects.filter((p) => p.title.toLowerCase().includes(lowerQuery));
    }

    return createSuccessResponse(requestId, 200, projects);
  }

  private async _handleGetProject(
    requestId: string,
    projectId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const project = await this._getProject(projectId);
    if (!project) {
      return this._projectNotFound(requestId);
    }
    return createSuccessResponse(requestId, 200, project);
  }

  private async _handleCreateProject(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseProjectFields(requestId, body);
    if (!parsed.ok) {
      return parsed.response;
    }
    const fields = parsed.value;
    if (fields.title === undefined) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Project title must be a non-empty string',
      );
    }

    // Same shape the create-project dialog submits: defaults, a random preset
    // color unless one is given, then the user's fields.
    const { theme, ...rest } = fields;
    const projectId = this._projectService.add({
      ...rest,
      theme: {
        ...DEFAULT_PROJECT.theme,
        primary: theme?.primary ?? getRandomWorkContextColor(),
      },
    });

    return createSuccessResponse(requestId, 201, await this._getProject(projectId));
  }

  private async _handleUpdateProject(
    requestId: string,
    projectId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseProjectFields(requestId, body);
    if (!parsed.ok) {
      return parsed.response;
    }

    const project = await this._getProject(projectId);
    if (!project) {
      return this._projectNotFound(requestId);
    }

    const { theme, ...rest } = parsed.value;
    const changes: Partial<Project> = {
      ...rest,
      ...(theme?.primary !== undefined
        ? { theme: { ...project.theme, primary: theme.primary } }
        : {}),
    };
    if (Object.keys(changes).length > 0) {
      this._projectService.update(projectId, changes);
    }

    return createSuccessResponse(requestId, 200, await this._getProject(projectId));
  }

  /**
   * Mirrors "Complete project" in the project menu: unfinished tasks are first
   * moved to the Inbox or marked done through the normal per-task actions, then
   * the project gets the single-entity complete flag flip (which archives it).
   * Where the app asks, the API needs `resolveUnfinishedTasks` up front.
   */
  private async _handleCompleteProject(
    requestId: string,
    projectId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseCompleteBody(requestId, body);
    if (!parsed.ok) {
      return parsed.response;
    }
    const resolveUnfinishedTasks = parsed.value;

    const project = await this._getProject(projectId);
    if (!project) {
      return this._projectNotFound(requestId);
    }
    if (project.id === INBOX_PROJECT.id) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'The Inbox project cannot be completed',
      );
    }
    if (project.isArchived) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Project is already archived',
      );
    }

    const info = await this._projectService.getCompletionInfo(projectId);
    if (info.unfinishedTasks.length > 0) {
      if (!resolveUnfinishedTasks) {
        return createErrorResponse(
          requestId,
          409,
          'UNFINISHED_TASKS',
          'Project has unfinished tasks — set resolveUnfinishedTasks to "inbox" or "markDone"',
          { unfinishedTaskIds: info.unfinishedTasks.map((task) => task.id) },
        );
      }
      if (resolveUnfinishedTasks === 'inbox') {
        await this._projectService.moveTasksToInbox(info.topLevelTasksWithUnfinishedWork);
      } else {
        await this._projectService.markTasksDone(info.unfinishedTasks);
      }
    }

    this._projectService.complete(
      projectId,
      this._dateService.getLogicalTodayDate().getTime(),
    );

    return createSuccessResponse(requestId, 200, await this._getProject(projectId));
  }

  /** Mirrors the project menu: reopen a completed project, unarchive an archived one. */
  private async _handleRestoreProject(
    requestId: string,
    projectId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const project = await this._getProject(projectId);
    if (!project) {
      return this._projectNotFound(requestId);
    }
    if (!project.isArchived) {
      return createErrorResponse(
        requestId,
        400,
        'INVALID_INPUT',
        'Project is not archived',
      );
    }

    if (project.isDone) {
      this._projectService.reopen(projectId, project);
    } else {
      await this._projectService.unarchive(projectId);
    }

    return createSuccessResponse(requestId, 200, await this._getProject(projectId));
  }

  private _parseProjectFields(
    requestId: string,
    body: unknown,
  ): BodyResult<WritableProjectFields> {
    if (!isRecord(body)) {
      return this._invalid(requestId, 'Request body must be a JSON object');
    }

    const themeBody = body.theme;
    const unsupported = [
      ...getUnsupportedFields(body, WRITABLE_PROJECT_FIELDS),
      ...(isRecord(themeBody)
        ? getUnsupportedFields(themeBody, WRITABLE_PROJECT_THEME_FIELDS, 'theme.')
        : []),
    ];
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

    const validation = typia.validate<WritableProjectFields>(body);
    if (!validation.success) {
      return this._invalid(
        requestId,
        'One or more project fields have an invalid type',
        toFieldTypeErrors(validation.errors),
      );
    }
    if (hasOwn(body, 'theme') && !isRecord(themeBody)) {
      return this._invalid(requestId, 'theme must be an object');
    }

    const fields = validation.data;
    if (fields.theme?.primary !== undefined && !isHexColor(fields.theme.primary)) {
      return this._invalid(requestId, 'theme.primary must be a #rgb or #rrggbb color');
    }
    if (fields.title !== undefined) {
      const title = fields.title.trim();
      if (!title) {
        return this._invalid(requestId, 'Project title must be a non-empty string');
      }
      return { ok: true, value: { ...fields, title } };
    }
    return { ok: true, value: fields };
  }

  private _parseCompleteBody(
    requestId: string,
    body: unknown,
  ): BodyResult<ResolveUnfinishedTasks | undefined> {
    if (body === undefined || body === null) {
      return { ok: true, value: undefined };
    }
    if (!isRecord(body)) {
      return this._invalid(requestId, 'Request body must be a JSON object');
    }
    const unsupported = getUnsupportedFields(body, new Set(['resolveUnfinishedTasks']));
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
    const value = body.resolveUnfinishedTasks;
    if (value === undefined) {
      return { ok: true, value: undefined };
    }
    if (!isResolveUnfinishedTasks(value)) {
      return this._invalid(
        requestId,
        'resolveUnfinishedTasks must be "inbox" or "markDone"',
      );
    }
    return { ok: true, value };
  }

  /** By id equality, so ids like `__proto__` can't resolve to prototype members. */
  private async _getProject(projectId: string): Promise<Project | undefined> {
    const projects = await firstValueFrom(this._store.select(selectAllProjects));
    return projects.find((project) => project.id === projectId);
  }

  private _projectNotFound(requestId: string): LocalRestApiResponsePayload {
    return createErrorResponse(requestId, 404, 'PROJECT_NOT_FOUND', 'Project not found');
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
