import { column as c, table, type TableRow } from "remix/data-table";

export const encryptedSecretPurposes = {
  gitCredential: "git-credential",
  providerApiKey: "provider-api-key",
} as const;

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

export const encryptedSecrets = table({
  name: "encrypted_secrets",
  columns: {
    id: c.uuid().primaryKey(),
    key: c.text().notNull(),
    purpose: c.text().notNull(),
    key_version: c.integer().notNull(),
    ciphertext: c.text().notNull(),
    created_at: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export const gitAuthorConfiguration = table({
  name: "git_author_configuration",
  primaryKey: "id",
  columns: {
    id: c.integer().primaryKey(),
    author_name: c.text().notNull(),
    author_email: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export const gitCredentials = table({
  name: "git_credentials",
  columns: {
    id: c.uuid().primaryKey(),
    host: c.text().notNull(),
    encrypted_secret_id: c
      .uuid()
      .notNull()
      .references("encrypted_secrets", "id", "git_credentials_encrypted_secret_fk")
      .onDelete("restrict"),
    created_at: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export const projects = table({
  name: "projects",
  columns: {
    id: c.uuid().primaryKey(),
    name: c.text().notNull(),
    repository_url: c.text().notNull(),
    default_ref: c.text().notNull(),
    default_branch_pattern: c.text().notNull(),
    created_at: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export type User = TableRow<typeof users>;
export type PasswordCredential = TableRow<typeof passwordCredentials>;
export type EncryptedSecretRow = TableRow<typeof encryptedSecrets>;
export type GitAuthorConfigurationRow = TableRow<typeof gitAuthorConfiguration>;
export type GitCredentialRow = TableRow<typeof gitCredentials>;
export type ProjectRow = TableRow<typeof projects>;
