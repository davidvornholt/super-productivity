import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { nanoid } from 'nanoid';
import typia, { IValidation } from 'typia';
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
import { ProjectService } from '../project/project.service';
import { NoteService } from './note.service';
import { Note } from './note.model';

/**
 * The fields the note UI writes: the text, the "pin to Today" toggle and the
 * project (via "Move to project"). Anything else is rejected rather than
 * ignored, so a client never believes a field was saved when it was not.
 */
const WRITABLE_NOTE_FIELDS: ReadonlySet<string> = new Set([
  'content',
  'projectId',
  'isPinnedToToday',
]);

interface CreateNoteFields {
  content: string;
  projectId?: string | null;
  isPinnedToToday?: boolean;
}

interface UpdateNoteFields {
  content?: string;
  projectId?: string;
  isPinnedToToday?: boolean;
}

type BodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: LocalRestApiResponsePayload };

/** Local REST API routes under `/notes`. */
@Injectable()
export class LocalRestApiNoteRoutesService implements LocalRestApiRouteHandler {
  private readonly _noteService = inject(NoteService);
  private readonly _projectService = inject(ProjectService);

  async handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined> {
    const { method, requestId, query, body } = request;
    const segments = getPathSegments(request.path);
    if (segments[0] !== 'notes') {
      return undefined;
    }

    if (segments.length === 1) {
      if (method === 'GET') {
        return this._handleListNotes(requestId, query);
      }
      if (method === 'POST') {
        return this._handleCreateNote(requestId, body);
      }
      return undefined;
    }

    if (segments.length === 2) {
      const noteId = segments[1];
      if (method === 'GET') {
        return this._handleGetNote(requestId, noteId);
      }
      if (method === 'PATCH') {
        return this._handleUpdateNote(requestId, noteId, body);
      }
      if (method === 'DELETE') {
        return this._handleDeleteNote(requestId, noteId);
      }
    }

    return undefined;
  }

  private async _handleListNotes(
    requestId: string,
    query: Record<string, string | string[]>,
  ): Promise<LocalRestApiResponsePayload> {
    const projectId = getQueryParam(query, 'projectId');

    let notes = await firstValueFrom(this._noteService.notes$);

    if (projectId) {
      notes = notes.filter((n) => n.projectId === projectId);
    }

    return createSuccessResponse(requestId, 200, notes);
  }

  private async _handleGetNote(
    requestId: string,
    noteId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const note = await this._getNote(noteId);
    if (!note) {
      return this._noteNotFound(requestId);
    }
    return createSuccessResponse(requestId, 200, note);
  }

  private async _handleCreateNote(
    requestId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseBody(requestId, body, (b) =>
      typia.validate<CreateNoteFields>(b),
    );
    if (!parsed.ok) {
      return parsed.response;
    }
    const { content, projectId = null, isPinnedToToday = false } = parsed.value;

    if (!content.trim()) {
      return this._invalid(requestId, 'content must be a non-empty string');
    }
    if (!projectId && !isPinnedToToday) {
      return this._invalid(
        requestId,
        'A note needs a projectId or isPinnedToToday: true, or it is shown nowhere',
      );
    }
    if (projectId && !(await this._isActiveProject(projectId))) {
      return this._projectNotFound(requestId);
    }

    // Pass the context explicitly: NoteService would otherwise take it from
    // whatever work context the UI is showing.
    const id = nanoid();
    this._noteService.add({ id, content, projectId, isPinnedToToday }, true);

    return createSuccessResponse(requestId, 201, await this._getNote(id));
  }

  private async _handleUpdateNote(
    requestId: string,
    noteId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    const parsed = this._parseBody(requestId, body, (b) =>
      typia.validate<UpdateNoteFields>(b),
    );
    if (!parsed.ok) {
      return parsed.response;
    }
    const { projectId, ...changes } = parsed.value;

    if (changes.content !== undefined && !changes.content.trim()) {
      return this._invalid(requestId, 'content must be a non-empty string');
    }

    const note = await this._getNote(noteId);
    if (!note) {
      return this._noteNotFound(requestId);
    }

    const isMove = projectId !== undefined && projectId !== note.projectId;
    if (isMove && !(await this._isActiveProject(projectId))) {
      return this._projectNotFound(requestId);
    }
    const resultingProjectId = isMove ? projectId : note.projectId;
    const resultingIsPinned = changes.isPinnedToToday ?? note.isPinnedToToday;
    if (!resultingProjectId && !resultingIsPinned) {
      return this._invalid(
        requestId,
        'A note without a project must stay pinned to Today, or it is shown nowhere',
      );
    }

    // The same actions as the note's menu: an update for text and pin, and
    // "Move to project", which also moves the note between project note lists.
    if (Object.keys(changes).length > 0) {
      this._noteService.update(noteId, changes);
    }
    if (isMove) {
      this._noteService.moveToOtherProject(note, projectId);
    }

    return createSuccessResponse(requestId, 200, await this._getNote(noteId));
  }

  private async _handleDeleteNote(
    requestId: string,
    noteId: string,
  ): Promise<LocalRestApiResponsePayload> {
    const note = await this._getNote(noteId);
    if (!note) {
      return this._noteNotFound(requestId);
    }

    this._noteService.remove(note);

    return createSuccessResponse(requestId, 200, { deleted: true, id: noteId });
  }

  private _parseBody<T>(
    requestId: string,
    body: unknown,
    validate: (body: Record<string, unknown>) => IValidation<T>,
  ): BodyResult<T> {
    if (!isRecord(body)) {
      return {
        ok: false,
        response: this._invalid(requestId, 'Request body must be a JSON object'),
      };
    }

    const unsupported = Object.keys(body).filter((key) => !WRITABLE_NOTE_FIELDS.has(key));
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

    const validation = validate(body);
    if (!validation.success) {
      return {
        ok: false,
        response: this._invalid(
          requestId,
          'One or more note fields have an invalid type',
          toFieldTypeErrors(validation.errors),
        ),
      };
    }
    return { ok: true, value: validation.data };
  }

  /** By id equality, so ids like `__proto__` can't resolve to prototype members. */
  private async _getNote(noteId: string): Promise<Note | undefined> {
    const notes = await firstValueFrom(this._noteService.notes$);
    return notes.find((note) => note.id === noteId);
  }

  /** Notes can only be added to or moved into projects the UI shows. */
  private async _isActiveProject(projectId: string): Promise<boolean> {
    const projects = await firstValueFrom(this._projectService.list$);
    return projects.some((project) => project.id === projectId);
  }

  private _noteNotFound(requestId: string): LocalRestApiResponsePayload {
    return createErrorResponse(requestId, 404, 'NOTE_NOT_FOUND', 'Note not found');
  }

  private _projectNotFound(requestId: string): LocalRestApiResponsePayload {
    return createErrorResponse(
      requestId,
      404,
      'PROJECT_NOT_FOUND',
      'Project not found or archived',
    );
  }

  private _invalid(
    requestId: string,
    message: string,
    details?: unknown,
  ): LocalRestApiResponsePayload {
    return createErrorResponse(requestId, 400, 'INVALID_INPUT', message, details);
  }
}
