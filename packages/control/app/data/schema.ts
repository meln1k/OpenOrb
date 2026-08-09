import { column as c, table, type TableRow } from "remix/data-table";

export const users = table({
  name: "users",
  columns: {
    id: c.integer().primaryKey(),
    created_at: c.text().notNull(),
  },
});

export const passwordCredentials = table({
  name: "password_credentials",
  primaryKey: "user_id",
  columns: {
    user_id: c.integer().primaryKey(),
    salt: c.text().notNull(),
    derived_key: c.text().notNull(),
    algorithm: c.text().notNull(),
    hash: c.text().notNull(),
    iterations: c.integer().notNull(),
    key_length_bits: c.integer().notNull(),
    created_at: c.text().notNull(),
  },
});

export type User = TableRow<typeof users>;
export type PasswordCredential = TableRow<typeof passwordCredentials>;
