import { test } from "vite-plus/test";
import { assertEquals } from "@jsr/std__assert";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { migrateDurableObjectDatabase } from "../app/cells/migrations.ts";
import { sessionMigrations } from "../app/cells/session/migrations.ts";
import { readGitSnapshot, readRecord } from "../app/cells/session/record.ts";
import { MemoryStorage } from "./workspace/storage.ts";

test("Session tables are migrated once, journaled, and share the database with Pi Durable", async () => {
  const storage = new MemoryStorage();
  const applied = await migrateDurableObjectDatabase(storage, sessionMigrations);
  assertEquals(
    applied.applied.map((migration) => migration.id),
    ["0001", "0002"],
  );
  assertEquals(storage.rows("SELECT id FROM data_table_migrations"), [
    { id: "0001" },
    { id: "0002" },
  ]);
  assertEquals(
    storage.rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'openorb_%' ORDER BY name",
    ),
    [
      { name: "openorb_git_snapshot" },
      { name: "openorb_inline_image" },
      { name: "openorb_media" },
      { name: "openorb_session" },
      { name: "openorb_thread_access" },
    ],
  );
  assertEquals(readRecord(storage), undefined);
  assertEquals(readGitSnapshot(storage), undefined);

  // Pi Durable versions its own tables in the same database without touching OpenOrb's journal.
  await openDurableObjectSqliteStorage(storage);
  assertEquals(storage.rows("SELECT version > 0 AS migrated FROM durable_schema"), [
    {
      migrated: 1,
    },
  ]);

  const unchanged = storage.dump();
  assertEquals((await migrateDurableObjectDatabase(storage, sessionMigrations)).applied, []);
  assertEquals(storage.dump(), unchanged);
});
