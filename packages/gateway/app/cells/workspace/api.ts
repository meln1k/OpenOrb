import type { Result } from "@openorb/result";
import type { Session } from "remix/session";
import { Schema } from "effect";
import {
  MAX_SESSION_SECRET_HOSTS,
  type SessionEnvironmentSecret,
  SessionId,
  type WorkspaceId,
  WorkspaceId as WorkspaceIdSchema,
} from "@openorb/protocol/runner-api";
import { SEARCH_PROVIDER_IDS, type SearchProviderId } from "../../search-provider-catalog.ts";

const Uuid = Schema.String.check(Schema.isUUID());
export const UserId = Uuid.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;
export const ProjectId = Uuid.pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;

const InitialPromptPreview = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && value === collapseWhitespace(value) && Array.from(value).length <= 200
      ? undefined
      : "Initial prompt previews must contain 1 to 200 normalized Unicode code points.",
  ),
);

/** The catalog's title for a Session: its prompt's first 200 code points on one line. */
export function initialPromptPreview(prompt: string): string {
  return Array.from(collapseWhitespace(prompt)).slice(0, 200).join("").trimEnd();
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export interface Administrator {
  userId: UserId;
  workspaceId: WorkspaceId;
}

export interface Project {
  id: string;
  name: string;
  repositoryUrl: string;
  defaultRef: string;
  defaultBranchPattern: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveProjectInput {
  id?: string | undefined;
  name: string;
  repositoryUrl: string;
}

export interface SecretEntry {
  key: string;
  keyVersion: number;
  allowedHosts?: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderCredential {
  id: string;
  providerId: string;
  credentialType: "api_key" | "oauth";
  createdAt: string;
  updatedAt: string;
}

export interface SearchProviderCredential {
  providerId: SearchProviderId;
  createdAt: string;
  updatedAt: string;
}

/** Configured web search keys by provider, decrypted only for the Session that searches. */
export type SearchProviderKeys = Partial<Record<SearchProviderId, string>>;

export interface GitAuthorConfiguration {
  authorName: string;
  authorEmail: string;
  updatedAt: string;
}

export interface GitCredential {
  id: string;
  host: "github.com";
  createdAt: string;
  updatedAt: string;
}

export interface RunnerEnrollmentToken {
  id: string;
  token: string;
  createdAt: string;
}

export interface RunnerRecord {
  id: string;
  name: string;
  architecture: "x64" | "arm64";
  createdAt: string;
  revokedAt: string | null;
}

export interface AuthenticatedRunner {
  id: string;
  workspaceId: WorkspaceId;
}

export interface SessionCatalogEntry {
  id: string;
  /** Absent for a Session without a project. */
  projectId?: string;
  createdAt: string;
  initialPromptPreview: string;
  /** The Session that created this Child Session (ADR 0010); absent for a top-level Session. */
  parentSessionId?: string;
}

export interface SessionNavigationEntry {
  id: string;
  /** Absent, with the name, for a Session without a project. */
  projectId?: string;
  projectName?: string;
  initialPromptPreview: string;
  /** The parent of a Child Session (ADR 0010), which the sidebar nests it under. */
  parentSessionId?: string;
}

/**
 * Workspace-wide Session facts the sidebar follows. Live only: each stream opens with the catalog
 * as it stands when the stream subscribes, so nothing created after that snapshot is missed.
 */
export type WorkspaceEvent =
  | { readonly type: "sessions.snapshot"; readonly sessions: SessionNavigationEntry[] }
  | { readonly type: "session.created"; readonly session: SessionNavigationEntry }
  /** The Session's Agent Run settled: the agent finished its work and is idle. */
  | { readonly type: "session.settled"; readonly sessionId: string };

export interface OpenAICodexAuthorization {
  readonly id: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
}

export type OpenAICodexAuthorizationStatus =
  | { readonly status: "pending"; readonly authorization: OpenAICodexAuthorization }
  | { readonly status: "complete" | "error" | "missing" };

export interface BrowserSessionRecord {
  data: Session["data"];
  userId: string | null;
  workspaceId: string | null;
  expiresAt: number;
}

export interface SaveBrowserSession {
  id: string;
  previousId?: string;
  mode: "insert" | "update" | "rotate";
  data: Session["data"];
}

/** Named native RPC operations. Values are plain records, never repository or class adapters. */
export interface WorkspaceApi {
  health(): Promise<void>;
  hasAdministrator(): Promise<boolean>;
  getAdministrator(userId: UserId): Promise<Administrator | null>;
  createAdministrator(password: string): Promise<Result<boolean, Error>>;
  verifyAdministratorPassword(password: string): Promise<Administrator | null>;
  listProjects(workspaceId: WorkspaceId): Promise<Project[]>;
  getProject(workspaceId: WorkspaceId, id: string): Promise<Project | null>;
  saveProject(
    workspaceId: WorkspaceId,
    input: SaveProjectInput,
  ): Promise<{ status: "saved"; project: Project } | { status: "not-found" | "name-conflict" }>;
  deleteProject(
    workspaceId: WorkspaceId,
    id: string,
  ): Promise<Result<"deleted" | "not-found" | "in-use", Error>>;
  listSecrets(workspaceId: WorkspaceId): Promise<SecretEntry[]>;
  getSecret(workspaceId: WorkspaceId, key: string): Promise<SecretEntry | null>;
  getEnvironmentSecrets(
    workspaceId: WorkspaceId,
  ): Promise<
    Result<readonly Pick<SessionEnvironmentSecret, "name" | "value" | "allowedHosts">[], Error>
  >;
  saveSecret(
    workspaceId: WorkspaceId,
    key: string,
    value: string,
    allowedHosts?: readonly string[],
  ): Promise<
    | { status: "saved"; secret: SecretEntry }
    | { status: "limit-exceeded" | "rpc-frame-limit-exceeded" }
  >;
  deleteSecret(workspaceId: WorkspaceId, key: string): Promise<boolean>;
  listModelProviderCredentials(workspaceId: WorkspaceId): Promise<ModelProviderCredential[]>;
  getModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
  ): Promise<ModelProviderCredential | null>;
  getModelProviderApiKey(
    workspaceId: WorkspaceId,
    id: string,
  ): Promise<Result<string | null, Error>>;
  saveModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
    apiKey: string,
  ): Promise<ModelProviderCredential>;
  deleteModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
  ): Promise<{ status: "deleted" | "not-found" }>;
  listSearchProviderCredentials(workspaceId: WorkspaceId): Promise<SearchProviderCredential[]>;
  getSearchProviderKeys(workspaceId: WorkspaceId): Promise<Result<SearchProviderKeys, Error>>;
  saveSearchProviderCredential(
    workspaceId: WorkspaceId,
    providerId: SearchProviderId,
    apiKey: string,
  ): Promise<SearchProviderCredential>;
  deleteSearchProviderCredential(
    workspaceId: WorkspaceId,
    providerId: SearchProviderId,
  ): Promise<{ status: "deleted" | "not-found" }>;
  getGitAuthorConfiguration(userId: UserId): Promise<GitAuthorConfiguration | null>;
  saveGitAuthorConfiguration(
    userId: UserId,
    input: { authorName: string; authorEmail: string },
  ): Promise<GitAuthorConfiguration>;
  getGitHubCredential(workspaceId: WorkspaceId): Promise<GitCredential | null>;
  getGitHubToken(workspaceId: WorkspaceId): Promise<Result<string | null, Error>>;
  saveGitHubCredential(workspaceId: WorkspaceId, token: string): Promise<GitCredential>;
  deleteGitHubCredential(workspaceId: WorkspaceId): Promise<{ status: "deleted" | "not-found" }>;
  getRunnerEnrollmentToken(workspaceId: WorkspaceId): Promise<RunnerEnrollmentToken>;
  regenerateRunnerEnrollmentToken(workspaceId: WorkspaceId): Promise<RunnerEnrollmentToken>;
  enrollRunner(input: {
    enrollmentPsk: string;
    name: string;
    architecture: "x64" | "arm64";
  }): Promise<{ runnerId: string; runnerToken: string } | null>;
  authenticateRunner(token: string): Promise<AuthenticatedRunner | null>;
  listRunners(workspaceId: WorkspaceId): Promise<RunnerRecord[]>;
  revokeRunner(workspaceId: WorkspaceId, id: string): Promise<"revoked" | "not-found">;
  deleteRunner(
    workspaceId: WorkspaceId,
    id: string,
  ): Promise<"deleted" | "not-found" | "not-revoked">;
  listSessionNavigationEntries(workspaceId: WorkspaceId): Promise<SessionNavigationEntry[]>;
  getSessionCatalogEntry(workspaceId: WorkspaceId, id: string): Promise<SessionCatalogEntry | null>;
  addSessionCatalogEntry(
    workspaceId: WorkspaceId,
    entry: SessionCatalogEntry,
  ): Promise<Result<void, Error>>;
  deleteSessionCatalogEntry(
    workspaceId: WorkspaceId,
    id: string,
  ): Promise<Result<"deleted" | "not-found", Error>>;
  /** A Session reports that its Agent Run settled, for the Workspace's event streams. */
  sessionSettled(workspaceId: WorkspaceId, id: string): Promise<void>;
  startProviderLogin(workspaceId: WorkspaceId): Promise<OpenAICodexAuthorization>;
  getProviderLoginStatus(
    workspaceId: WorkspaceId,
    attemptId: string,
  ): Promise<OpenAICodexAuthorizationStatus>;
  cancelProviderLogin(workspaceId: WorkspaceId, attemptId: string): Promise<void>;
  disconnectProvider(workspaceId: WorkspaceId): Promise<{ status: "deleted" | "not-found" }>;
  resolveProviderAccessToken(workspaceId: WorkspaceId): Promise<string | null>;
  readBrowserSession(id: string): Promise<BrowserSessionRecord | null>;
  saveBrowserSession(input: SaveBrowserSession): Promise<boolean>;
  deleteBrowserSessions(ids: string[]): Promise<void>;
}

export type WorkspaceOperation = keyof WorkspaceApi;

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(4096));
const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,100}$/));
const SearchProvider = Schema.Literals(SEARCH_PROVIDER_IDS);
const Owner = Schema.Tuple([WorkspaceIdSchema]);
const OwnedIdentifier = Schema.Tuple([WorkspaceIdSchema, Identifier]);
const BrowserData = Schema.mutable(
  Schema.Tuple([
    Schema.Record(Schema.String, Schema.Unknown),
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);

type WorkspaceArgumentSchemas = {
  [K in WorkspaceOperation]: Schema.Codec<Readonly<Parameters<WorkspaceApi[K]>>, unknown>;
};

/** Validate native RPC arguments before any storage or provider side effect. */
const WORKSPACE_ARGUMENTS: WorkspaceArgumentSchemas = {
  health: Schema.Tuple([]),
  hasAdministrator: Schema.Tuple([]),
  getAdministrator: Schema.Tuple([UserId]),
  createAdministrator: Schema.Tuple([Text]),
  verifyAdministratorPassword: Schema.Tuple([Schema.String.check(Schema.isMaxLength(4096))]),
  listProjects: Owner,
  getProject: OwnedIdentifier,
  saveProject: Schema.Tuple([
    WorkspaceIdSchema,
    Schema.Struct({
      id: Schema.optional(Identifier),
      name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
      repositoryUrl: Text,
    }),
  ]),
  deleteProject: OwnedIdentifier,
  listSecrets: Owner,
  getSecret: OwnedIdentifier,
  getEnvironmentSecrets: Owner,
  saveSecret: Schema.Tuple([
    WorkspaceIdSchema,
    Identifier,
    Schema.String.check(Schema.isMaxLength(4096)),
    Schema.optional(
      Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_SESSION_SECRET_HOSTS)),
    ),
  ]),
  deleteSecret: OwnedIdentifier,
  listModelProviderCredentials: Owner,
  getModelProviderCredential: OwnedIdentifier,
  getModelProviderApiKey: OwnedIdentifier,
  saveModelProviderCredential: Schema.Tuple([WorkspaceIdSchema, Identifier, Text]),
  deleteModelProviderCredential: OwnedIdentifier,
  listSearchProviderCredentials: Owner,
  getSearchProviderKeys: Owner,
  saveSearchProviderCredential: Schema.Tuple([WorkspaceIdSchema, SearchProvider, Text]),
  deleteSearchProviderCredential: Schema.Tuple([WorkspaceIdSchema, SearchProvider]),
  getGitAuthorConfiguration: Schema.Tuple([UserId]),
  saveGitAuthorConfiguration: Schema.Tuple([
    UserId,
    Schema.Struct({ authorName: Text, authorEmail: Text }),
  ]),
  getGitHubCredential: Owner,
  getGitHubToken: Owner,
  saveGitHubCredential: Schema.Tuple([WorkspaceIdSchema, Text]),
  deleteGitHubCredential: Owner,
  getRunnerEnrollmentToken: Owner,
  regenerateRunnerEnrollmentToken: Owner,
  enrollRunner: Schema.Tuple([
    Schema.Struct({
      enrollmentPsk: Text,
      name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
      architecture: Schema.Literals(["x64", "arm64"]),
    }),
  ]),
  authenticateRunner: Schema.Tuple([Text]),
  listRunners: Owner,
  revokeRunner: OwnedIdentifier,
  deleteRunner: OwnedIdentifier,
  listSessionNavigationEntries: Owner,
  getSessionCatalogEntry: OwnedIdentifier,
  addSessionCatalogEntry: Schema.Tuple([
    WorkspaceIdSchema,
    Schema.Struct({
      id: SessionId,
      projectId: Schema.optionalKey(ProjectId),
      createdAt: Schema.String,
      initialPromptPreview: InitialPromptPreview,
      parentSessionId: Schema.optionalKey(SessionId),
    }),
  ]),
  deleteSessionCatalogEntry: OwnedIdentifier,
  sessionSettled: Schema.Tuple([WorkspaceIdSchema, SessionId]),
  startProviderLogin: Owner,
  getProviderLoginStatus: OwnedIdentifier,
  cancelProviderLogin: OwnedIdentifier,
  disconnectProvider: Owner,
  resolveProviderAccessToken: Owner,
  readBrowserSession: Schema.Tuple([Identifier]),
  saveBrowserSession: Schema.Tuple([
    Schema.Struct({
      id: Identifier,
      previousId: Schema.optionalKey(Identifier),
      mode: Schema.Literals(["insert", "update", "rotate"]),
      data: BrowserData,
    }),
  ]),
  deleteBrowserSessions: Schema.Tuple([
    Schema.mutable(Schema.Array(Identifier)).check(Schema.isMaxLength(2)),
  ]),
};

// SAFETY: The closed schema map contains exactly the WorkspaceApi operations.
export const WORKSPACE_OPERATIONS = Object.keys(WORKSPACE_ARGUMENTS) as WorkspaceOperation[];

export function decodeWorkspaceArguments<K extends WorkspaceOperation>(
  operation: K,
  input: unknown,
): Readonly<Parameters<WorkspaceApi[K]>> {
  const schema = WORKSPACE_ARGUMENTS[operation];
  return Schema.decodeUnknownSync(schema)(input);
}
