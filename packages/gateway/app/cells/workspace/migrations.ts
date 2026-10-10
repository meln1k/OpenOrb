import { Database, type MigrationDescriptor } from "remix/data-table";
import createWorkspaceTables from "./migrations/0001_create_workspace_tables/up.sql" with {
  type: "text",
};
import type { WorkspaceStorage } from "./workspace.ts";

export const workspaceMigrations: MigrationDescriptor[] = [
  { id: "0001", name: "create_workspace_tables", up: createWorkspaceTables },
];

/** Remix owns the journal; native DO storage owns the transaction and connection. */
export async function migrateWorkspaceDatabase(
  storage: WorkspaceStorage,
  migrations: MigrationDescriptor[],
) {
  const unsupported = (): never => {
    throw new Error(
      "Workspace migration driver only supports raw SQL inside storage.transaction()",
    );
  };
  const database = new Database({
    dialect: "sqlite",
    capabilities: {
      returning: false,
      savepoints: false,
      upsert: false,
      transactionalDdl: false,
      migrationLock: false,
    },
    execute({ operation }) {
      if (operation.kind !== "raw") return unsupported();
      return Promise.resolve({
        rows: storage.sql.exec(operation.sql.text, ...operation.sql.values).toArray(),
      });
    },
    executeScript(sql) {
      storage.sql.exec(sql).toArray();
      return Promise.resolve();
    },
    beginTransaction: unsupported,
    commitTransaction: unsupported,
    rollbackTransaction: unsupported,
    hasTable: unsupported,
    hasColumn: unsupported,
    createSavepoint: unsupported,
    rollbackToSavepoint: unsupported,
    releaseSavepoint: unsupported,
    wipe: unsupported,
    close() {},
  });
  const writeVersion = () =>
    JSON.stringify(
      storage.sql.exec(
        "SELECT total_changes() AS changes, schema_version AS schemaVersion FROM pragma_schema_version",
      ).toArray()[0],
    );
  let changed = false;
  const result = await storage.transaction(async () => {
    const before = writeVersion();
    const result = await database.migrate(
      migrations.map((migration) => ({ ...migration, transaction: "none" })),
    );
    changed = writeVersion() !== before;
    return result;
  });
  if (changed) await storage.sync();
  return result;
}
