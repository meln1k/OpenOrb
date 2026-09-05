import { object, parseSafe, string } from "remix/data-schema";
import { v7 } from "@std/uuid";
import { UserId, WorkspaceId } from "@openorb/protocol/runner-api";

export const BROWSER_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const browserSessionAuthSchema = object(
  {
    userId: string().refine(v7.validate, "Expected a UUID v7 user ID.").transform((value) =>
      UserId.make(value)
    ),
    workspaceId: string().refine(v7.validate, "Expected a UUID v7 workspace ID.").transform((
      value,
    ) => WorkspaceId.make(value)),
  },
  { unknownKeys: "error" },
);

export function parseBrowserSessionAuth(
  value: unknown,
): { userId: UserId; workspaceId: WorkspaceId } | null {
  const parsed = parseSafe(browserSessionAuthSchema, value);
  return parsed.success ? parsed.value : null;
}
