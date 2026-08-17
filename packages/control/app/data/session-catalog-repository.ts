import type { RunnerSessionSnapshot } from "@openorb/protocol";
import type { Database } from "remix/data-table";

import { deletedSessions, type SessionRow, sessions } from "@/app/data/schema.ts";

export type RejectedSessionSnapshotReason = "catalog-conflict" | "project-not-found";

export interface RejectedSessionSnapshot {
  sessionId: string;
  reason: RejectedSessionSnapshotReason;
}

export interface ReconciledSessionSnapshots {
  acceptedSessionIds: string[];
  tombstonedSessionIds: string[];
  rejected: RejectedSessionSnapshot[];
}

export interface SessionCatalogRepository {
  reconcileSessionSnapshotEntries(
    userId: string,
    entries: RunnerSessionSnapshot[],
  ): Promise<ReconciledSessionSnapshots>;
}

class SessionSnapshotReconciliationRejected extends Error {
  constructor(readonly result: ReconciledSessionSnapshots) {
    super("Session snapshot reconciliation rejected.");
  }
}

export function createSessionCatalogRepository(database: Database): SessionCatalogRepository {
  return {
    async reconcileSessionSnapshotEntries(userId, entries) {
      try {
        return await database.transaction(async (transaction) => {
          // Tombstone inserts take a key-share lock on this referenced user row. Holding the
          // conflicting update lock through reconciliation makes either the tombstone or the
          // catalog snapshot win first, so a deletion can never miss an uncommitted catalog row.
          await transaction.exec(
            "select id from users where id = $1 for update",
            [userId],
          );

          const result: ReconciledSessionSnapshots = {
            acceptedSessionIds: [],
            tombstonedSessionIds: [],
            rejected: [],
          };

          for (const entry of entries) {
            const tombstone = await transaction.findOne(deletedSessions, {
              where: { user_id: userId, session_id: entry.id },
            });
            if (tombstone) {
              result.tombstonedSessionIds.push(entry.id);
              continue;
            }

            await transaction.exec(
              `insert into sessions (
               user_id, id, project_id, created_at, initial_prompt_preview
             )
             select $1, $2, $3, $4, $5
              where exists (
                select 1
                  from projects
                 where user_id = $1
                   and id = $3
              )
                and not exists (
                  select 1
                    from deleted_sessions
                   where user_id = $1
                     and session_id = $2
                )
             on conflict (user_id, id) do nothing`,
              [userId, entry.id, entry.projectId, entry.createdAt, entry.initialPromptPreview],
            );

            const row = await transaction.findOne(sessions, {
              where: { user_id: userId, id: entry.id },
            });
            if (!row) {
              const deleted = await transaction.findOne(deletedSessions, {
                where: { user_id: userId, session_id: entry.id },
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
            throw new SessionSnapshotReconciliationRejected({
              ...result,
              acceptedSessionIds: [],
            });
          }
          return result;
        });
      } catch (error) {
        if (error instanceof SessionSnapshotReconciliationRejected) return error.result;
        throw error;
      }
    },
  };
}

function catalogFieldsMatch(row: SessionRow, entry: RunnerSessionSnapshot): boolean {
  return row.project_id === entry.projectId &&
    row.created_at === entry.createdAt &&
    row.initial_prompt_preview === entry.initialPromptPreview;
}
