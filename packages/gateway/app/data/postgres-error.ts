import { any, object, optional, parseSafe, string } from "remix/data-schema";

const postgresErrorSchema = object({
  code: optional(string()),
  cause: optional(any()),
});

export function hasPostgresErrorCode(error: unknown, ...codes: string[]): boolean {
  const parsed = parseSafe(postgresErrorSchema, error);
  if (!parsed.success) return false;
  if (parsed.value.code !== undefined && codes.includes(parsed.value.code)) return true;
  return parsed.value.cause === undefined
    ? false
    : hasPostgresErrorCode(parsed.value.cause, ...codes);
}
