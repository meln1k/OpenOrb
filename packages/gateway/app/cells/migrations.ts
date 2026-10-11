import { Database, type MigrationDescriptor } from "remix/data-table";
import { Predicate } from "effect";

/** Values Remix binds for its migration journal: ids, names, checksums, and batch numbers. */
type JournalValue = string | number | null;
/** Values SQLite-backed Durable Object storage returns. */
type SqlValue = ArrayBuffer | string | number | null;

/** The native SQLite-backed Durable Object storage a migration needs. */
export interface MigrationStorage {
  readonly sql: {
    exec(query: string, ...bindings: JournalValue[]): { toArray(): Record<string, SqlValue>[] };
  };
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  sync(): Promise<void>;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Applies pending migrations to one Durable Object's SQLite storage, journaled by Remix
 * `data-table`. Native DO storage owns the transaction, so all pending migrations commit together.
 * Run it under `blockConcurrencyWhile` before the object reads its tables.
 */
export async function migrateDurableObjectDatabase(
  storage: MigrationStorage,
  migrations: MigrationDescriptor[],
) {
  const unsupported = (): never => {
    throw new MigrationError(
      "The migration driver only supports raw SQL inside storage.transaction()",
    );
  };
  const journalValue = (value: unknown): JournalValue => {
    if (value === null || Predicate.isString(value) || Predicate.isNumber(value)) return value;
    throw new MigrationError("The migration driver binds only text and numbers.");
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
      const bindings = operation.sql.values.map(journalValue);
      return Promise.resolve({ rows: storage.sql.exec(operation.sql.text, ...bindings).toArray() });
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
