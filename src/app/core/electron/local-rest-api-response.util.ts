import { LocalRestApiResponsePayload } from '../../../../electron/shared-with-frontend/local-rest-api.model';

/**
 * Request/response helpers shared by the Local REST API handler and the
 * feature-owned route handlers (see `LOCAL_REST_API_ROUTE_HANDLERS`), so every
 * route answers with the same `{ ok, data }` / `{ ok, error }` envelope.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** `/projects/abc/archive` → `['projects', 'abc', 'archive']` */
export const getPathSegments = (path: string): string[] =>
  path.split('/').filter(Boolean);

export const getQueryParam = (
  query: Record<string, string | string[]>,
  key: string,
): string | undefined => {
  const value = query[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Copies only the allowlisted keys of a request body. This filters by key
 * only; callers still have to validate the value types (typia) before
 * anything reaches the store or the op-log.
 */
export const pickFields = (
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) {
      result[key] = body[key];
    }
  }
  return result;
};

/** The `error.details` entry of a 400 for a wrong-typed field. */
export type FieldTypeError = { path: string; expected: string };

export const toFieldTypeErrors = (
  errors: readonly { path: string; expected: string }[],
): FieldTypeError[] => errors.map(({ path, expected }) => ({ path, expected }));

export const createErrorResponse = (
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): LocalRestApiResponsePayload => ({
  requestId,
  status,
  body: {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  },
});

export const createSuccessResponse = (
  requestId: string,
  status: number,
  data: unknown,
): LocalRestApiResponsePayload => ({
  requestId,
  status,
  body: {
    ok: true,
    data,
  },
});
