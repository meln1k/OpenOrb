import { column as c, ColumnBuilder, table, type TableRow } from "remix/data-table";

export const encryptedSecretPurposes = {
  genericSecret: "generic-secret",
  gitCredential: "git-credential",
  providerApiKey: "provider-api-key",
  providerOAuth: "provider-oauth",
} as const;

// Remix declarations describe native SQL row shapes and primary keys; table() does not emit DDL.
// Colocated migrations/ SQL enforces checks, indexes, composite foreign keys, and the deletion trigger.
// BLOBs are ArrayBuffers in native DO storage; c.binary() otherwise infers unknown.
export const workspaces = table({
  name: "workspaces",
  primaryKey: "id",
  columns: {
    id: c.text().notNull(),
    singleton: c.integer().notNull(),
    createdAt: c.text().notNull(),
  },
});

export const users = table({
  name: "users",
  primaryKey: "id",
  columns: {
    id: c.text().notNull(),
    workspaceId: c.text().notNull(),
    isAdministrator: c.integer().notNull(),
    createdAt: c.text().notNull(),
  },
});

export const passwordCredentials = table({
  name: "password_credentials",
  primaryKey: "userId",
  columns: {
    userId: c.text().notNull(),
    salt: new ColumnBuilder<ArrayBuffer>({ type: "binary" }).notNull(),
    derivedKey: new ColumnBuilder<ArrayBuffer>({ type: "binary" }).notNull(),
    algorithm: c.text().notNull(),
    hash: c.text().notNull(),
    iterations: c.integer().notNull(),
    keyLengthBits: c.integer().notNull(),
  },
});

export const encryptedSecrets = table({
  name: "encrypted_secrets",
  primaryKey: ["workspaceId", "key"],
  columns: {
    workspaceId: c.text().notNull(),
    key: c.text().notNull(),
    purpose: c.enum(Object.values(encryptedSecretPurposes)).notNull(),
    keyVersion: c.integer().notNull(),
    ciphertext: new ColumnBuilder<ArrayBuffer>({ type: "binary" }).notNull(),
    allowedHosts: c.text().nullable(),
    createdAt: c.text().notNull(),
    updatedAt: c.text().notNull(),
  },
});

export const modelProviderCredentials = table({
  name: "model_provider_credentials",
  primaryKey: ["workspaceId", "providerId"],
  columns: {
    id: c.text().notNull(),
    workspaceId: c.text().notNull(),
    providerId: c.text().notNull(),
    credentialType: c.enum(["api_key", "oauth"] as const).notNull(),
    secretKey: c.text().notNull(),
    createdAt: c.text().notNull(),
    updatedAt: c.text().notNull(),
  },
});

export const gitAuthorConfiguration = table({
  name: "git_author_configuration",
  primaryKey: "userId",
  columns: {
    userId: c.text().notNull(),
    authorName: c.text().notNull(),
    authorEmail: c.text().notNull(),
    updatedAt: c.text().notNull(),
  },
});

export const gitCredentials = table({
  name: "git_credentials",
  primaryKey: ["workspaceId", "host"],
  columns: {
    id: c.text().notNull(),
    workspaceId: c.text().notNull(),
    host: c.enum(["github.com"] as const).notNull(),
    secretKey: c.text().notNull(),
    createdAt: c.text().notNull(),
    updatedAt: c.text().notNull(),
  },
});

export const projects = table({
  name: "projects",
  primaryKey: ["workspaceId", "id"],
  columns: {
    workspaceId: c.text().notNull(),
    id: c.text().notNull(),
    name: c.text().notNull(),
    repositoryUrl: c.text().notNull(),
    defaultRef: c.text().notNull(),
    defaultBranchPattern: c.text().notNull(),
    createdAt: c.text().notNull(),
    updatedAt: c.text().notNull(),
  },
});

export const runnerEnrollmentTokens = table({
  name: "runner_enrollment_tokens",
  primaryKey: "workspaceId",
  columns: {
    workspaceId: c.text().notNull(),
    id: c.text().notNull(),
    token: c.text().notNull(),
    tokenHash: c.text().notNull(),
    createdAt: c.text().notNull(),
  },
});

export const runners = table({
  name: "runners",
  primaryKey: ["workspaceId", "id"],
  columns: {
    workspaceId: c.text().notNull(),
    id: c.text().notNull(),
    name: c.text().notNull(),
    architecture: c.enum(["x64", "arm64"] as const).notNull(),
    tokenHash: c.text().notNull(),
    createdAt: c.text().notNull(),
    revokedAt: c.text().nullable(),
  },
});

export const sessions = table({
  name: "sessions",
  primaryKey: ["workspaceId", "id"],
  columns: {
    workspaceId: c.text().notNull(),
    id: c.text().notNull(),
    projectId: c.text().notNull(),
    createdAt: c.text().notNull(),
    initialPromptPreview: c.text().notNull(),
  },
});

export const deletedSessions = table({
  name: "deleted_sessions",
  primaryKey: ["workspaceId", "sessionId"],
  columns: {
    workspaceId: c.text().notNull(),
    sessionId: c.text().notNull(),
    deletedAt: c.text().notNull(),
  },
});

export const browserSessions = table({
  name: "browser_sessions",
  primaryKey: "id",
  columns: {
    id: c.text().notNull(),
    data: c.text().notNull(),
    userId: c.text().nullable(),
    workspaceId: c.text().nullable(),
    expiresAt: c.integer().notNull(),
  },
});

export const providerAuthorizations = table({
  name: "provider_authorizations",
  primaryKey: "workspaceId",
  columns: {
    workspaceId: c.text().notNull(),
    id: c.text().notNull(),
    status: c.enum(["pending", "complete", "error"] as const).notNull(),
    login: c.text().nullable(),
  },
});

export type Workspace = TableRow<typeof workspaces>;
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
export type BrowserSessionRow = TableRow<typeof browserSessions>;
export type ProviderAuthorizationRow = TableRow<typeof providerAuthorizations>;
