import type { AdministratorRepository } from "../../gateway/app/data/administrator-repository.ts";
import type { GitConfigurationRepository } from "../../gateway/app/data/git-configuration-repository.ts";
import type { ModelProviderRepository } from "../../gateway/app/data/model-provider-repository.ts";
import type { ProjectRepository } from "../../gateway/app/data/project-repository.ts";
import type { RunnerRepository } from "../../gateway/app/data/runner-repository.ts";
import type { SecretRepository } from "../../gateway/app/data/secret-repository.ts";
import type { EnvironmentSecretReadError } from "../../gateway/app/data/secret-repository.ts";
import type { SessionCatalogRepository } from "../../gateway/app/data/session-catalog-repository.ts";
import type { SessionCatalogEntry } from "../../gateway/app/data/session-catalog-repository.ts";
import type {
  RunnerEnrollmentToken,
  RunnerRecord,
} from "../../gateway/app/data/runner-repository.ts";
import type { Result } from "@openorb/result";
import type {
  OpenAICodexAuthorization,
  OpenAICodexAuthorizationStatus,
} from "../../gateway/app/openai-codex-authorization.ts";
import type { WorkspaceId } from "@openorb/protocol/runner-api";
import type { Session } from "remix/session";
import { Schema, SchemaTransformation } from "effect";
import {
  MAX_SESSION_SECRET_HOSTS,
  RunnerSessionSnapshot,
  type SessionEnvironmentSecret,
  UserId,
  WorkspaceId as WorkspaceIdSchema,
} from "@openorb/protocol/runner-api";

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

/** Domain operations, not SQL or callback-bearing repository calls. */
export interface WorkspaceApi
  extends
    AdministratorRepository,
    GitConfigurationRepository,
    ProjectRepository,
    RunnerRepository,
    SecretRepository,
    SessionCatalogRepository,
    Pick<
      ModelProviderRepository,
      | "listModelProviderCredentials"
      | "getModelProviderCredential"
      | "getModelProviderApiKey"
      | "saveModelProviderCredential"
      | "deleteModelProviderCredential"
    > {
  startProviderLogin(workspaceId: WorkspaceId): Promise<OpenAICodexAuthorization>;
  getProviderLoginStatus(
    workspaceId: WorkspaceId,
    attemptId: string,
  ): Promise<OpenAICodexAuthorizationStatus>;
  cancelProviderLogin(workspaceId: WorkspaceId, attemptId: string): Promise<void>;
  disconnectProvider(workspaceId: WorkspaceId): Promise<{ status: "deleted" | "not-found" }>;
  resolveProviderAccessToken(workspaceId: WorkspaceId, now?: number): Promise<string | null>;
  readBrowserSession(id: string): Promise<BrowserSessionRecord | null>;
  saveBrowserSession(input: SaveBrowserSession): Promise<boolean>;
  deleteBrowserSessions(ids: string[]): Promise<void>;
}

/** Native RPC carries plain records, not Temporal or Schema.Class instances. */
export interface WorkspaceRpc extends
  Omit<
    WorkspaceApi,
    | "getRunnerEnrollmentToken"
    | "regenerateRunnerEnrollmentToken"
    | "listRunners"
    | "getEnvironmentSecrets"
    | "reconcileSessionManifestEntries"
  > {
  health(): Promise<void>;
  getRunnerEnrollmentToken(
    workspaceId: WorkspaceId,
  ): Promise<Omit<RunnerEnrollmentToken, "createdAt"> & { createdAt: string }>;
  regenerateRunnerEnrollmentToken(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceRpc["getRunnerEnrollmentToken"]>;
  listRunners(
    workspaceId: WorkspaceId,
  ): Promise<(Omit<RunnerRecord, "createdAt" | "revokedAt"> & {
    createdAt: string;
    revokedAt: string | null;
  })[]>;
  getEnvironmentSecrets(
    workspaceId: WorkspaceId,
  ): Promise<
    Result<
      readonly Pick<SessionEnvironmentSecret, "name" | "value" | "allowedHosts">[],
      EnvironmentSecretReadError
    >
  >;
  reconcileSessionManifestEntries(
    workspaceId: WorkspaceId,
    entries: readonly SessionCatalogEntry[],
  ): ReturnType<WorkspaceApi["reconcileSessionManifestEntries"]>;
}

export type WorkspaceOperation = keyof WorkspaceApi;

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(4096));
const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,100}$/));
const Owner = Schema.Tuple([WorkspaceIdSchema]);
const OwnedIdentifier = Schema.Tuple([WorkspaceIdSchema, Identifier]);
const BrowserData = Schema.mutable(Schema.Tuple([
  Schema.Record(Schema.String, Schema.Unknown),
  Schema.Record(Schema.String, Schema.Unknown),
]));

type WorkspaceArgumentSchemas = {
  [K in WorkspaceOperation]: Schema.Codec<Readonly<Parameters<WorkspaceApi[K]>>, unknown>;
};

/** Parse every HTTP operation before any storage or provider side effect. */
const WORKSPACE_ARGUMENTS: WorkspaceArgumentSchemas = {
  hasAdministrator: Schema.Tuple([]),
  getAdministrator: Schema.Tuple([UserId]),
  createAdministrator: Schema.Tuple([Text]),
  verifyAdministratorPassword: Schema.Tuple([Schema.String.check(Schema.isMaxLength(4096))]),
  listProjects: Owner,
  getProject: OwnedIdentifier,
  saveProject: Schema.Tuple([
    WorkspaceIdSchema,
    Schema.Struct({
      id: Schema.optionalKey(Identifier),
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
    Schema.optionalKey(
      Schema.NullOr(Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_SESSION_SECRET_HOSTS)))
        .pipe(Schema.decodeTo(
          Schema.UndefinedOr(Schema.Array(Schema.String)),
          SchemaTransformation.transform({
            decode: (hosts) => hosts ?? undefined,
            encode: (hosts) => hosts ?? null,
          }),
        )),
    ),
  ]),
  deleteSecret: OwnedIdentifier,
  listModelProviderCredentials: Owner,
  getModelProviderCredential: OwnedIdentifier,
  getModelProviderApiKey: OwnedIdentifier,
  saveModelProviderCredential: Schema.Tuple([WorkspaceIdSchema, Identifier, Text]),
  deleteModelProviderCredential: OwnedIdentifier,
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
  enrollRunner: Schema.Tuple([Schema.Struct({
    enrollmentPsk: Text,
    name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
    architecture: Schema.Literals(["x64", "arm64"]),
  })]),
  authenticateRunner: Schema.Tuple([Text]),
  listRunners: Owner,
  revokeRunner: OwnedIdentifier,
  deleteRunner: OwnedIdentifier,
  listSessionNavigationEntries: Owner,
  getSessionCatalogEntry: OwnedIdentifier,
  deleteSessionCatalogEntry: Schema.Tuple([WorkspaceIdSchema, Identifier, Text]),
  reconcileSessionManifestEntries: Schema.Tuple([
    WorkspaceIdSchema,
    Schema.mutable(Schema.Array(RunnerSessionSnapshot)).check(Schema.isMaxLength(10000)),
  ]),
  startProviderLogin: Owner,
  getProviderLoginStatus: OwnedIdentifier,
  cancelProviderLogin: OwnedIdentifier,
  disconnectProvider: Owner,
  resolveProviderAccessToken: Schema.Tuple([WorkspaceIdSchema, Schema.optionalKey(Schema.Number)]),
  readBrowserSession: Schema.Tuple([Identifier]),
  saveBrowserSession: Schema.Tuple([Schema.Struct({
    id: Identifier,
    previousId: Schema.optionalKey(Identifier),
    mode: Schema.Literals(["insert", "update", "rotate"]),
    data: BrowserData,
  })]),
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
