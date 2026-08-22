import { column as c, table, type TableRow } from "remix/data-table";

export const encryptedSecretPurposes = {
  genericSecret: "generic-secret",
  gitCredential: "git-credential",
  providerApiKey: "provider-api-key",
} as const;

export const users = table({
  name: "users",
  columns: {
    id: c.uuid().primaryKey(),
    is_administrator: c.boolean().notNull(),
    created_at: c.text().notNull(),
  },
});

export const passwordCredentials = table({
  name: "password_credentials",
  primaryKey: "user_id",
  columns: {
    user_id: c.uuid().primaryKey(),
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
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "encrypted_secrets_user_fk")
      .onDelete("cascade"),
    key: c.text().notNull(),
    purpose: c.text().notNull(),
    key_version: c.integer().notNull(),
    ciphertext: c.text().notNull(),
    created_at: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export const modelProviderCredentials = table({
  name: "model_provider_credentials",
  columns: {
    id: c.uuid().primaryKey(),
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "model_provider_credentials_user_fk")
      .onDelete("cascade"),
    provider_id: c.text().notNull(),
    encrypted_secret_id: c
      .uuid()
      .notNull()
      .references("encrypted_secrets", "id", "model_provider_credentials_secret_fk")
      .onDelete("restrict"),
    created_at: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export const gitAuthorConfiguration = table({
  name: "git_author_configuration",
  primaryKey: "user_id",
  columns: {
    user_id: c
      .uuid()
      .primaryKey()
      .references("users", "id", "git_author_configuration_user_fk")
      .onDelete("cascade"),
    author_name: c.text().notNull(),
    author_email: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export const gitCredentials = table({
  name: "git_credentials",
  columns: {
    id: c.uuid().primaryKey(),
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "git_credentials_user_fk")
      .onDelete("cascade"),
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
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "projects_user_fk")
      .onDelete("cascade"),
    name: c.text().notNull(),
    repository_url: c.text().notNull(),
    default_ref: c.text().notNull(),
    default_branch_pattern: c.text().notNull(),
    created_at: c.text().notNull(),
    updated_at: c.text().notNull(),
  },
});

export const runnerEnrollmentTokens = table({
  name: "runner_enrollment_tokens",
  columns: {
    id: c.uuid().primaryKey(),
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "runner_enrollment_tokens_user_fk")
      .onDelete("cascade"),
    token: c.text().nullable(),
    token_hash: c.text().notNull(),
    created_at: c.text().notNull(),
    revoked_at: c.text().nullable(),
  },
});

export const runners = table({
  name: "runners",
  columns: {
    id: c.uuid().primaryKey(),
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "runners_user_fk")
      .onDelete("cascade"),
    enrollment_token_id: c.uuid().notNull(),
    name: c.text().notNull(),
    architecture: c.text().notNull(),
    capabilities: c.text().notNull(),
    token_hash: c.text().notNull(),
    created_at: c.text().notNull(),
    revoked_at: c.text().nullable(),
  },
});

export const sessions = table({
  name: "sessions",
  primaryKey: ["user_id", "id"],
  columns: {
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "sessions_user_fk")
      .onDelete("cascade"),
    id: c.uuid().notNull(),
    project_id: c.uuid().notNull(),
    created_at: c.text().notNull(),
    initial_prompt_preview: c.text().notNull(),
  },
});

export const deletedSessions = table({
  name: "deleted_sessions",
  primaryKey: ["user_id", "session_id"],
  columns: {
    user_id: c
      .uuid()
      .notNull()
      .references("users", "id", "deleted_sessions_user_fk")
      .onDelete("cascade"),
    session_id: c.uuid().notNull(),
    deleted_at: c.text().notNull(),
  },
});

export type User = TableRow<typeof users>;
export type PasswordCredential = TableRow<typeof passwordCredentials>;
export type EncryptedSecretRow = TableRow<typeof encryptedSecrets>;
export type ModelProviderCredentialRow = TableRow<typeof modelProviderCredentials>;
export type GitAuthorConfigurationRow = TableRow<typeof gitAuthorConfiguration>;
export type GitCredentialRow = TableRow<typeof gitCredentials>;
export type ProjectRow = TableRow<typeof projects>;
export type RunnerEnrollmentTokenRow = TableRow<typeof runnerEnrollmentTokens>;
export type RunnerRow = TableRow<typeof runners>;
export type SessionRow = TableRow<typeof sessions>;
export type DeletedSessionRow = TableRow<typeof deletedSessions>;
