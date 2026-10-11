import type { MigrationDescriptor } from "remix/data-table";
import { migrateDurableObjectDatabase } from "../migrations.ts";
import createWorkspaceTables from "./migrations/0001_create_workspace_tables/up.sql" with {
  type: "text",
};
import type { WorkspaceStorage } from "./workspace.ts";

export const workspaceMigrations: MigrationDescriptor[] = [
  { id: "0001", name: "create_workspace_tables", up: createWorkspaceTables },
];

export function migrateWorkspaceDatabase(
  storage: WorkspaceStorage,
  migrations: MigrationDescriptor[],
) {
  return migrateDurableObjectDatabase(storage, migrations);
}
