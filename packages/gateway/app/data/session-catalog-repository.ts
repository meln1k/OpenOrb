import type { RunnerSessionSnapshot, WorkspaceId } from "@openorb/protocol/runner-api";
import { err, ok, type Result, tryAsync } from "@openorb/result";
import type { Database } from "remix/data-table";

import { deletedSessions, type SessionRow, sessions } from "@/app/data/schema.ts";

export type RejectedSessionManifestEntryReason = "catalog-conflict" | "project-not-found";

export interface RejectedSessionManifestEntry {
  sessionId: string;
  reason: RejectedSessionManifestEntryReason;
}

export interface ReconciledSessionManifest {
  acceptedSessionIds: string[];
  tombstonedSessionIds: string[];
  rejected: RejectedSessionManifestEntry[];
}

export class SessionCatalogPersistenceError extends Error {
  constructor(override readonly cause: unknown) {
    super("Session catalog persistence failed.", { cause });
    this.name = "SessionCatalogPersistenceError";
  }
}

export interface SessionCatalogEntry {
  id: string;
  projectId: string;
  createdAt: string;
  initialPromptPreview: string;
}

export type DeleteSessionCatalogResult = "deleted" | "not-found";

export interface SessionCatalogRepository {
  listSessionCatalogEntries(workspaceId: WorkspaceId): Promise<SessionCatalogEntry[]>;
  getSessionCatalogEntry(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<SessionCatalogEntry | null>;
  deleteSessionCatalogEntry(
    workspaceId: WorkspaceId,
    sessionId: string,
    deletedAt: string,
  ): Promise<Result<DeleteSessionCatalogResult, SessionCatalogPersistenceError>>;
  reconcileSessionManifestEntries(
    workspaceId: WorkspaceId,
    entries: RunnerSessionSnapshot[],
  ): Promise<Result<ReconciledSessionManifest, SessionCatalogPersistenceError>>;
}

class SessionManifestReconciliationRejected extends Error {
  constructor(readonly result: ReconciledSessionManifest) {
    super("Session manifest reconciliation rejected.");
  }
}

export function createSessionCatalogRepository(database: Database): SessionCatalogRepository {
  return {
    async listSessionCatalogEntries(workspaceId) {
      const rows = await database.findMany(sessions, {
        where: { workspace_id: workspaceId },
        orderBy: ["created_at", "desc"],
      });
      return rows.map(mapSessionCatalogEntry);
    },

    async getSessionCatalogEntry(workspaceId, sessionId) {
      const row = await database.findOne(sessions, {
        where: { workspace_id: workspaceId, id: sessionId },
      });
      return row ? mapSessionCatalogEntry(row) : null;
    },

    async deleteSessionCatalogEntry(workspaceId, sessionId, deletedAt) {
      return await tryAsync(
        database.transaction(async (transaction) => {
          // Reconciliation takes the same workspace-row lock. Exactly one transaction can decide
          // whether this session is live or tombstoned at a time.
          await transaction.exec(
            "select id from workspaces where id = $1 for update",
            [workspaceId],
          );
          const row = await transaction.findOne(sessions, {
            where: { workspace_id: workspaceId, id: sessionId },
          });
          if (!row) return "not-found" as const;

          await transaction.exec(
            `insert into deleted_sessions (workspace_id, session_id, deleted_at)
             values ($1, $2, $3)
             on conflict (workspace_id, session_id) do nothing`,
            [workspaceId, sessionId, deletedAt],
          );
          await transaction.exec(
            "delete from sessions where workspace_id = $1 and id = $2",
            [workspaceId, sessionId],
          );
          return "deleted" as const;
        }),
        (cause) => new SessionCatalogPersistenceError(cause),
      );
    },

    async reconcileSessionManifestEntries(workspaceId, entries) {
      const [result, transactionError] = await tryAsync(
        database.transaction(async (transaction) => {
          // Tombstone inserts take a key-share lock on this referenced workspace row. Holding the
          // conflicting update lock through reconciliation makes either the tombstone or the
          // catalog snapshot win first, so a deletion can never miss an uncommitted catalog row.
          await transaction.exec(
            "select id from workspaces where id = $1 for update",
            [workspaceId],
          );

          const result: ReconciledSessionManifest = {
            acceptedSessionIds: [],
            tombstonedSessionIds: [],
            rejected: [],
          };

          for (const entry of entries) {
            const tombstone = await transaction.findOne(deletedSessions, {
              where: { workspace_id: workspaceId, session_id: entry.id },
            });
            if (tombstone) {
              result.tombstonedSessionIds.push(entry.id);
              continue;
            }

            await transaction.exec(
              `insert into sessions (
               workspace_id, id, project_id, created_at, initial_prompt_preview
             )
             select $1, $2, $3, $4, $5
              where exists (
                select 1
                  from projects
                 where workspace_id = $1
                   and id = $3
              )
                and not exists (
                  select 1
                    from deleted_sessions
                   where workspace_id = $1
                     and session_id = $2
                )
             on conflict (workspace_id, id) do nothing`,
              [workspaceId, entry.id, entry.projectId, entry.createdAt, entry.initialPromptPreview],
            );

            const row = await transaction.findOne(sessions, {
              where: { workspace_id: workspaceId, id: entry.id },
            });
            if (!row) {
              const deleted = await transaction.findOne(deletedSessions, {
                where: { workspace_id: workspaceId, session_id: entry.id },
              });
              if (deleted) result.tombstonedSessionIds.push(entry.id);
              else result.rejected.push({ sessionId: entry.id, reason: "project-not-found" });
              continue;
            }
            if (!catalogFieldsMatch(row, entry)) {
              result.rejected.push({ sessionId: entry.id, reason: "catalog-conflict" });
              continue;
            }
            result.acceptedSessionIds.push(entry.id);
          }

          if (result.rejected.length > 0) {
            throw new SessionManifestReconciliationRejected({
              ...result,
              acceptedSessionIds: [],
            });
          }
          return result;
        }),
        (cause) => new SessionCatalogPersistenceError(cause),
      );
      if (transactionError !== undefined) {
        if (transactionError.cause instanceof SessionManifestReconciliationRejected) {
          return ok(transactionError.cause.result);
        }
        return err(transactionError);
      }
      return ok(result);
    },
  };
}

function mapSessionCatalogEntry(row: SessionRow): SessionCatalogEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    initialPromptPreview: row.initial_prompt_preview,
  };
}

function catalogFieldsMatch(row: SessionRow, entry: RunnerSessionSnapshot): boolean {
  return row.project_id === entry.projectId &&
    row.created_at === entry.createdAt &&
    row.initial_prompt_preview === entry.initialPromptPreview;
}
