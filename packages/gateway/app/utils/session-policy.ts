import { object, parseSafe, string } from "remix/data-schema";
import { v7 } from "@std/uuid";

export const BROWSER_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const browserSessionAuthSchema = object(
  {
    userId: string().refine(v7.validate, "Expected a UUID v7 user ID."),
  },
  { unknownKeys: "error" },
);

export function parseBrowserSessionAuth(value: unknown): { userId: string } | null {
  const parsed = parseSafe(browserSessionAuthSchema, value);
  return parsed.success ? parsed.value : null;
}
