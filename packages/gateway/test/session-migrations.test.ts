import { test } from "vite-plus/test";
import { assertEquals, assertThrows } from "@jsr/std__assert";
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
    ["0001"],
  );
  assertEquals(storage.rows("SELECT id FROM data_table_migrations"), [{ id: "0001" }]);
  assertEquals(
    storage.rows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'openorb_%' ORDER BY name",
    ),
    [
      { name: "openorb_git_snapshot" },
      { name: "openorb_inline_image" },
      { name: "openorb_media" },
      { name: "openorb_session" },
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

test("Session records without a placement were runner Sessions and read as such", async () => {
  const storage = new MemoryStorage();
  await migrateDurableObjectDatabase(storage, sessionMigrations);
  const record = {
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    gitAuthor: { name: "A", email: "a@example.com" },
  };
  const runnerId = crypto.randomUUID();
  const project = {
    projectId: crypto.randomUUID(),
    repositoryUrl: "https://github.com/acme/app.git",
    ref: "main",
    branchName: "openorb/legacy",
  };
  storage.sql.exec(
    "INSERT INTO openorb_session (id, record) VALUES (1, ?)",
    JSON.stringify({ ...record, ...project, environmentProvider: "runner", runnerId }),
  );
  const legacy = readRecord(storage);
  assertEquals(legacy?.placement, { provider: "runner", runnerId });
  // Flat project fields become the optional project, with the user's Git author.
  assertEquals(legacy?.project?.id, project.projectId);
  assertEquals(legacy?.project?.repositoryUrl, project.repositoryUrl);
  assertEquals(legacy?.project?.branchName, project.branchName);
  assertEquals(legacy?.project?.gitAuthor.email, "a@example.com");
  for (const flat of [
    "runnerId",
    "environmentProvider",
    "projectId",
    "repositoryUrl",
    "gitAuthor",
  ]) {
    assertEquals(legacy !== undefined && flat in legacy, false, flat);
  }

  // A record with neither a placement nor a runner is corrupt and fails loudly.
  storage.sql.exec(
    "UPDATE openorb_session SET record = ? WHERE id = 1",
    JSON.stringify({ ...record, environmentProvider: "runner" }),
  );
  assertThrows(() => readRecord(storage));

  storage.sql.exec(
    "UPDATE openorb_session SET record = ? WHERE id = 1",
    JSON.stringify({ ...record, placement: { provider: "sandbox" } }),
  );
  assertEquals(readRecord(storage)?.placement, { provider: "sandbox" });
});
