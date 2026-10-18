import type { WorkspaceId } from "@openorb/protocol/runner-api";
import { err, ok, type Result, tryAsync } from "@openorb/result";
import { initialPromptPreview, type WorkspaceApi } from "../workspace/api.ts";
import type { CreateSessionInput, SessionApi } from "./api.ts";

/** Why a Session did not start, and whether it is still in the catalog. */
export class StartSessionError extends Error {
  constructor(
    /** `record`: the catalog refused the entry; `create`: the Session did not start. */
    readonly stage: "record" | "create",
    message: string,
    /** The catalog entry, and possibly the Session, remain: it may have started after all. */
    readonly kept: boolean,
  ) {
    super(message);
    this.name = "StartSessionError";
  }
}

/**
 * Records a Session in the Workspace catalog, then creates it, for the browser and for
 * create_thread alike. The entry comes first, so a Session that fails to start stays visible and
 * deletable; it is removed only when the Session confirms it holds no record, never after an
 * ambiguous failure that may have left it running. Repeating the same start is harmless.
 */
export async function startSession(
  workspace: Pick<WorkspaceApi, "addSessionCatalogEntry" | "deleteSessionCatalogEntry">,
  session: Pick<SessionApi, "create" | "view">,
  input: CreateSessionInput & { readonly workspaceId: WorkspaceId },
): Promise<Result<void, StartSessionError>> {
  const [, catalogError] = await workspace.addSessionCatalogEntry(input.workspaceId, {
    id: input.sessionId,
    ...(input.project === undefined ? {} : { projectId: input.project.id }),
    createdAt: input.createdAt,
    initialPromptPreview: initialPromptPreview(input.initialPrompt),
    ...(input.origin.kind === "parent" ? { parentSessionId: input.origin.sessionId } : {}),
  });
  if (catalogError !== undefined) {
    return err(new StartSessionError("record", catalogError.message, false));
  }
  const [, createError] = await tryAsync(session.create(input), (cause) =>
    cause instanceof Error ? cause.message : "The session is unavailable.",
  );
  if (createError !== undefined) {
    const recorded = await holdsRecord(session);
    if (!recorded) await workspace.deleteSessionCatalogEntry(input.workspaceId, input.sessionId);
    return err(new StartSessionError("create", createError, recorded));
  }
  return ok(undefined);
}

/** Whether the Session may hold a record; only a definite "none" lets the catalog entry go. */
async function holdsRecord(session: Pick<SessionApi, "view">): Promise<boolean> {
  const [view, viewError] = await tryAsync(session.view(), () => "unknown");
  if (viewError !== undefined) return true;
  return view !== null;
}
