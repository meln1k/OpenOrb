import { Workspace, type WorkspaceStorage } from "../../app/cells/workspace/workspace.ts";
import type { Env } from "../../app/env.ts";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlStorageValue } from "@cloudflare/workers-types";

/** Disposable key, never read from the process environment. */
export const TEST_MASTER_KEY_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
export const TEST_MASTER_KEY_BYTES = Uint8Array.fromHex(TEST_MASTER_KEY_HEX);

/** Real disposable SQLite, with the native storage SQL/transaction surface used by Workspace. */
export class MemoryStorage implements WorkspaceStorage {
  readonly #database = new DatabaseSync(":memory:");
  #transactionId = 0;
  alarm: number | null = null;

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      let rows: Record<string, SqlStorageValue>[];
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) {
        throw new Error("Use native storage transactions instead of transaction-control SQL");
      }
      if (/^\s*(CREATE|ALTER|DROP)\b/i.test(query) && bindings.length === 0) {
        // Migration scripts include multiple DDL statements; consume the whole script.
        this.#database.exec(query);
        rows = [];
      } else {
        // SAFETY: Native SQL accepts these scalar bindings, plus ArrayBuffer BLOBs.
        const values = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value
        ) as SQLInputValue[];
        // SAFETY: node:sqlite returns integer numbers unless setReadBigInts(true) is used.
        rows = this.#database.prepare(query).all(...values).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Uint8Array ? Uint8Array.from(value).buffer : value,
            ]),
          )
        ) as Record<string, SqlStorageValue>[];
      }
      return { toArray: () => structuredClone(rows) };
    },
  };

  rows<T = Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    // SAFETY: Test callers select columns matching their inspection type.
    return this.sql.exec(query, ...bindings).toArray() as T[];
  }

  dump(): string {
    const tables = this.rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    return JSON.stringify(
      Object.fromEntries(tables.map(({ name }) => [name, this.rows(`SELECT * FROM "${name}"`)])),
      (_key, value) => value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value,
    );
  }

  transactionSync<T>(callback: () => T): T {
    const savepoint = `transaction_${this.#transactionId++}`;
    this.#database.exec(`SAVEPOINT ${savepoint}`);
    const alarm = this.alarm;
    try {
      const value = callback();
      this.#database.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      this.#database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      this.alarm = alarm;
      throw error;
    }
  }

  async transaction<T>(callback: (storage: WorkspaceStorage) => Promise<T>): Promise<T> {
    const savepoint = `transaction_${this.#transactionId++}`;
    this.#database.exec(`SAVEPOINT ${savepoint}`);
    const alarm = this.alarm;
    try {
      const value = await callback(this);
      this.#database.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      this.#database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      this.alarm = alarm;
      throw error;
    }
  }

  setAlarm(time: number): Promise<void> {
    this.alarm = time;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarm = null;
    return Promise.resolve();
  }

  sync(): Promise<void> {
    return Promise.resolve();
  }
}

export function activate(storage = new MemoryStorage(), masterKey = TEST_MASTER_KEY_HEX) {
  // SAFETY: Logic tests exercise only storage and the explicit key, not native namespace bindings.
  const environment = { OPENORB_MASTER_KEY: masterKey } as Env;
  const workspace = new Workspace(
    { storage, blockConcurrencyWhile: (callback) => callback() },
    environment,
  );
  return { workspace, storage };
}

export async function createWorkspace(password = "workspace-fixture-password") {
  const context = activate();
  const [created, error] = await context.workspace.createAdministrator(password);
  if (!created || error !== undefined) throw new Error("Fixture administrator was not created");
  const administrator = await context.workspace.verifyAdministratorPassword(password);
  if (!administrator) throw new Error("Fixture administrator was not authenticated");
  return { ...context, administrator, workspaceId: administrator.workspaceId };
}
