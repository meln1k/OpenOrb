import type { MigrationDescriptor } from "remix/data-table";
import createSessionTables from "./migrations/0001_create_session_tables/up.sql" with { type: "text" };
import threadAccess from "./migrations/0002_thread_access/up.sql" with { type: "text" };

/** OpenOrb's own Session tables; Pi Durable migrates its tables itself (`durable_schema`). */
export const sessionMigrations: MigrationDescriptor[] = [
  { id: "0001", name: "create_session_tables", up: createSessionTables },
  { id: "0002", name: "thread_access", up: threadAccess },
];
