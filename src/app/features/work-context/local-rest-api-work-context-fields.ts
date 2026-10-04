/**
 * Field checks shared by the project and tag routes of the Local REST API.
 * Unlike the task routes (which ignore unknown fields for backwards
 * compatibility), these newer routes reject every key outside their
 * allowlist, so a typo or a relational/state field (`taskIds`, `isArchived`,
 * ...) is reported instead of silently dropped.
 */

/** The `#rgb` / `#rrggbb` form the app's color picker produces. */
const HEX_COLOR_REGEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const isHexColor = (value: string): boolean => HEX_COLOR_REGEX.test(value);

export const getUnsupportedFields = (
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string = '',
): string[] =>
  Object.keys(body)
    .filter((key) => !allowed.has(key))
    .map((key) => `${prefix}${key}`);
