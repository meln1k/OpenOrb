import type { MigrationDescriptor } from "remix/data-table";
import { migrateDurableObjectDatabase } from "../migrations.ts";
import createWorkspaceTables from "./migrations/0001_create_workspace_tables/up.sql" with { type: "text" };
import optionalSessionProject from "./migrations/0002_optional_session_project/up.sql" with { type: "text" };
import dropSessionTombstones from "./migrations/0003_drop_session_tombstones/up.sql" with { type: "text" };
import searchProviderCredentials from "./migrations/0004_search_provider_credentials/up.sql" with { type: "text" };
import type { WorkspaceStorage } from "./workspace.ts";

export const workspaceMigrations: MigrationDescriptor[] = [
  { id: "0001", name: "create_workspace_tables", up: createWorkspaceTables },
  { id: "0002", name: "optional_session_project", up: optionalSessionProject },
  { id: "0003", name: "drop_session_tombstones", up: dropSessionTombstones },
  { id: "0004", name: "search_provider_credentials", up: searchProviderCredentials },
];

export function migrateWorkspaceDatabase(
  storage: WorkspaceStorage,
  migrations: MigrationDescriptor[],
) {
  return migrateDurableObjectDatabase(storage, migrations);
}
