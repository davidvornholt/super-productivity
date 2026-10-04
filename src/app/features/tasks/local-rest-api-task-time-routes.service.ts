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
  isRecord,
  toFieldTypeErrors,
} from '../../core/electron/local-rest-api-response.util';
import { DateService } from '../../core/date/date.service';
import { isValidDBDateStr } from '../../util/get-db-date-str';
import { TaskService } from './task.service';
import { Task, TimeSpentOnDayCopy } from './task.model';

const WRITABLE_TIME_FIELDS: ReadonlySet<string> = new Set(['date', 'ms']);

interface SetTimeSpentFields {
  date?: string;
  ms: number;
}

/**
 * Local REST API route for the time spent on a task per day:
 * `PUT /tasks/:id/time`. It edits `timeSpentOnDay` the way the time
 * estimate dialog does, so the reducer recomputes `timeSpent` and the
 * parent's totals.
 */
@Injectable()
export class LocalRestApiTaskTimeRoutesService implements LocalRestApiRouteHandler {
  private readonly _taskService = inject(TaskService);
  private readonly _dateService = inject(DateService);

  async handle(
    request: LocalRestApiRequestPayload,
  ): Promise<LocalRestApiResponsePayload | undefined> {
    const segments = getPathSegments(request.path);
    if (
      request.method === 'PUT' &&
      segments.length === 3 &&
      segments[0] === 'tasks' &&
      segments[2] === 'time'
    ) {
      return this._handleSetTimeSpent(request.requestId, segments[1], request.body);
    }
    return undefined;
  }

  private async _handleSetTimeSpent(
    requestId: string,
    taskId: string,
    body: unknown,
  ): Promise<LocalRestApiResponsePayload> {
    if (!isRecord(body)) {
      return this._invalid(requestId, 'Request body must be a JSON object');
    }
    const unsupported = Object.keys(body).filter((key) => !WRITABLE_TIME_FIELDS.has(key));
    if (unsupported.length > 0) {
      return createErrorResponse(
        requestId,
        400,
        'UNSUPPORTED_FIELD',
        `Field(s) cannot be set through this endpoint: ${unsupported.join(', ')}`,
        { fields: unsupported },
      );
    }
    const validation = typia.validate<SetTimeSpentFields>(body);
    if (!validation.success) {
      return this._invalid(
        requestId,
        'One or more fields have an invalid type',
        toFieldTypeErrors(validation.errors),
      );
    }
    const { ms } = validation.data;
    if (!Number.isSafeInteger(ms) || ms < 0) {
      return this._invalid(requestId, 'ms must be a non-negative integer');
    }
    // Default to the app's current day, which respects "start of next day".
    const date = validation.data.date ?? this._dateService.todayStr();
    if (!isValidDBDateStr(date)) {
      return this._invalid(requestId, 'date must be a valid YYYY-MM-DD date');
    }

    const task = await this._getTask(taskId);
    if (!task) {
      return createErrorResponse(requestId, 404, 'TASK_NOT_FOUND', 'Task not found');
    }
    if (task.subTaskIds.length > 0) {
      // A parent's time is the sum of its subtasks' time; the app only offers
      // the time dialog for tasks without subtasks.
      return this._invalid(
        requestId,
        'Time of a task with subtasks is the sum of its subtasks; set it on a subtask',
      );
    }

    const current = task.timeSpentOnDay?.[date] ?? 0;
    if (ms !== current) {
      // Same as saving the time estimate dialog: the whole map, with a day
      // removed rather than kept at 0.
      const timeSpentOnDay: TimeSpentOnDayCopy = { ...task.timeSpentOnDay };
      if (ms > 0) {
        timeSpentOnDay[date] = ms;
      } else {
        delete timeSpentOnDay[date];
      }
      this._taskService.update(taskId, { timeSpentOnDay });
    }

    return createSuccessResponse(requestId, 200, await this._getTask(taskId));
  }

  /** Active tasks only; the id check keeps `__proto__` and friends out. */
  private async _getTask(taskId: string): Promise<Task | undefined> {
    const task = await firstValueFrom(this._taskService.getByIdOnce$(taskId));
    return task?.id === taskId ? task : undefined;
  }

  private _invalid(
    requestId: string,
    message: string,
    details?: unknown,
  ): LocalRestApiResponsePayload {
    return createErrorResponse(requestId, 400, 'INVALID_INPUT', message, details);
  }
}
