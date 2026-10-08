import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { v7 } from "@std/uuid";
import { ENROLLMENT_PSK_PREFIX, RUNNER_TOKEN_PREFIX } from "@openorb/protocol";
import {
  MAX_SESSION_ENVIRONMENT_SECRETS,
  SessionEnvironmentSecret,
  SessionEnvironmentSecrets,
  UserId,
  type WorkspaceId,
  WorkspaceId as WorkspaceIdSchema,
} from "@openorb/protocol/runner-api";
import { ok } from "@openorb/result";
import {
  hashPassword,
  type PasswordHash,
  verifyPassword,
} from "../../gateway/app/utils/password.ts";
import { loadMasterKey, type MasterKey } from "../../gateway/app/utils/master-key.ts";
import {
  decryptSecret,
  type EncryptedSecret,
  encryptSecret,
} from "../../gateway/app/utils/secret-cipher.ts";
import { generateRunnerSecret, hashRunnerSecret } from "../../gateway/app/utils/runner-token.ts";
import {
  BROWSER_SESSION_MAX_AGE_SECONDS,
  parseBrowserSessionAuth,
} from "../../gateway/app/utils/session-policy.ts";
import type { Env } from "./env.ts";
import type { Project, SaveProjectInput } from "../../gateway/app/data/project-repository.ts";
import type { RunnerEnrollmentRequest } from "@openorb/protocol";
import type { GitAuthorConfiguration } from "../../gateway/app/data/git-configuration-repository.ts";
import type {
  ReconciledSessionManifest,
  SessionCatalogEntry,
} from "../../gateway/app/data/session-catalog-repository.ts";
import type { BrowserSessionRecord, SaveBrowserSession, WorkspaceRpc } from "./api.ts";
import {
  type DeviceLogin,
  type OAuthCredential,
  pollDeviceLogin,
  refreshOAuthCredential,
  revokeOAuthCredential,
  startDeviceLogin,
} from "./oauth.ts";

/** Native SQLite-backed DO storage; no host database or filesystem adapter. */
export interface WorkspaceStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  transaction<T>(callback: (storage: WorkspaceStorage) => Promise<T>): Promise<T>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface AdministratorRecord {
  userId: string;
  workspaceId: WorkspaceId;
  password: PasswordHash;
}

interface Secret extends EncryptedSecret {
  key: string;
  workspaceId: WorkspaceId;
  createdAt: string;
  updatedAt: string;
  allowedHosts?: readonly string[];
}

interface Provider {
  id: string;
  providerId: string;
  credentialType: "api_key" | "oauth";
  secret: Secret;
  createdAt: string;
  updatedAt: string;
}

interface Runner {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  architecture: "x64" | "arm64";
  tokenHash: string;
  createdAt: string;
  revokedAt: string | null;
}

interface Enrollment {
  id: string;
  token: string;
  tokenHash: string;
  createdAt: string;
}

type Login =
  | { status: "pending"; login: DeviceLogin }
  | { status: "complete" | "error"; id: string };

/** One configuration owner. Runner connections and agent sessions remain outside this object. */
export class Workspace extends DurableObject<Env> implements WorkspaceRpc {
  readonly #storage: WorkspaceStorage;
  readonly #masterKey: Promise<MasterKey>;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    context: { storage: WorkspaceStorage },
    environment: Env,
  ) {
    super(context, environment);
    this.#storage = context.storage;
    this.#masterKey = loadMasterKey(environment.OPENORB_MASTER_KEY);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    // ponytail: one configuration queue; split hot session/runner traffic into their own DOs later.
    const result = this.#tail.catch(() => {}).then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  async health(): Promise<void> {
    await this.#masterKey;
  }

  alarm(): Promise<void> {
    return this.#pollLogin();
  }

  async #values<T>(prefix: string): Promise<T[]> {
    return [...(await this.#storage.list<T>({ prefix })).values()];
  }

  async #requireWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const administrator = await this.#storage.get<AdministratorRecord>("administrator");
    if (!administrator || administrator.workspaceId !== workspaceId) {
      throw new Error("Workspace not found");
    }
  }

  async #encrypt(
    workspaceId: WorkspaceId,
    key: string,
    plaintext: string,
    existing?: Secret,
  ): Promise<Secret> {
    const encrypted = await encryptSecret(await this.#masterKey, plaintext, { workspaceId, key });
    const now = new Date().toISOString();
    return {
      ...encrypted,
      key,
      workspaceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  async #decrypt(secret: Secret): Promise<string> {
    const [value, error] = await decryptSecret(await this.#masterKey, secret, {
      workspaceId: secret.workspaceId,
      key: secret.key,
    });
    if (error !== undefined) throw error;
    return value;
  }

  #providerMetadata(provider: Provider) {
    const { secret: _secret, ...metadata } = provider;
    return metadata;
  }

  async #saveProvider(
    workspaceId: WorkspaceId,
    providerId: string,
    credential: string | OAuthCredential,
    storage: WorkspaceStorage = this.#storage,
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(providerId)) throw new Error("Invalid provider");
    const key = `provider:${workspaceId}:${providerId}`;
    const existing = await storage.get<Provider>(key);
    const secret = await this.#encrypt(
      workspaceId,
      existing?.secret.key ?? crypto.randomUUID(),
      Schema.is(Schema.String)(credential) ? credential : JSON.stringify(credential),
      existing?.secret,
    );
    const provider: Provider = {
      id: existing?.id ?? crypto.randomUUID(),
      providerId,
      credentialType: Schema.is(Schema.String)(credential) ? "api_key" : "oauth",
      secret,
      createdAt: existing?.createdAt ?? secret.createdAt,
      updatedAt: secret.updatedAt,
    };
    await storage.put(key, provider);
    return this.#providerMetadata(provider);
  }

  async #pollLogin(): Promise<void> {
    const state = await this.#serialize(() => this.#storage.get<Login>("oauth-login"));
    if (!state || state.status !== "pending") return;
    const result = await pollDeviceLogin(state.login);
    await this.#serialize(async () => {
      const current = await this.#storage.get<Login>("oauth-login");
      if (current?.status !== "pending" || current.login.id !== state.login.id) return;
      const administrator = await this.#storage.get<AdministratorRecord>("administrator");
      if (!administrator) throw new Error("Workspace not found");
      await this.#storage.transaction(async (storage) => {
        if (result.status === "pending") {
          await storage.put("oauth-login", result);
          await storage.setAlarm(result.login.nextPollAt);
        } else {
          if (result.status === "complete") {
            await this.#saveProvider(
              administrator.workspaceId,
              "openai-codex",
              result.credential,
              storage,
            );
          }
          await storage.put<Login>("oauth-login", { status: result.status, id: state.login.id });
          await storage.deleteAlarm();
        }
      });
    });
  }

  hasAdministrator(): ReturnType<WorkspaceRpc["hasAdministrator"]> {
    return this.#serialize(async () => (await this.#storage.get("administrator")) !== undefined);
  }

  getAdministrator(userId: UserId): ReturnType<WorkspaceRpc["getAdministrator"]> {
    return this.#serialize(async () => {
      const administrator = await this.#storage.get<AdministratorRecord>("administrator");
      return administrator?.userId === userId
        ? { userId: UserId.make(administrator.userId), workspaceId: administrator.workspaceId }
        : null;
    });
  }

  createAdministrator(input: string): ReturnType<WorkspaceRpc["createAdministrator"]> {
    return this.#serialize(async () => {
      const password = await hashPassword(input);
      return this.#storage.transaction(async (storage) => {
        if (await storage.get("administrator")) return ok(false);
        await storage.put<AdministratorRecord>("administrator", {
          userId: v7.generate(),
          workspaceId: WorkspaceIdSchema.make(v7.generate()),
          password,
        });
        return ok(true);
      });
    });
  }

  verifyAdministratorPassword(
    password: string,
  ): ReturnType<WorkspaceRpc["verifyAdministratorPassword"]> {
    return this.#serialize(async () => {
      const administrator = await this.#storage.get<AdministratorRecord>("administrator");
      if (
        !administrator || !await verifyPassword(password, administrator.password)
      ) return null;
      return { userId: UserId.make(administrator.userId), workspaceId: administrator.workspaceId };
    });
  }

  listProjects(workspaceId: WorkspaceId): ReturnType<WorkspaceRpc["listProjects"]> {
    return this.#serialize(async () =>
      (await this.#values<Project>(`project:${workspaceId}:`)).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    );
  }

  getProject(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceRpc["getProject"]> {
    return this.#serialize(async () =>
      await this.#storage.get<Project>(`project:${workspaceId}:${id}`) ?? null
    );
  }

  saveProject(
    workspaceId: WorkspaceId,
    input: SaveProjectInput,
  ): ReturnType<WorkspaceRpc["saveProject"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      const existing = input.id
        ? await this.#storage.get<Project>(`project:${workspaceId}:${input.id}`)
        : undefined;
      if (input.id && !existing) return { status: "not-found" };
      const projects = await this.#values<Project>(`project:${workspaceId}:`);
      if (projects.some((p) => p.name === input.name && p.id !== input.id)) {
        return { status: "name-conflict" };
      }
      const now = new Date().toISOString();
      const project: Project = {
        id: existing?.id ?? crypto.randomUUID(),
        name: input.name,
        repositoryUrl: input.repositoryUrl,
        defaultRef: "main",
        defaultBranchPattern: "openorb/{session-name}-{short-session-id}",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.#storage.put(`project:${workspaceId}:${project.id}`, project);
      return { status: "saved", project };
    });
  }

  deleteProject(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceRpc["deleteProject"]> {
    return this.#serialize(async () => {
      if (!await this.#storage.get(`project:${workspaceId}:${id}`)) return ok("not-found");
      if (
        (await this.#values<SessionCatalogEntry>(`session:${workspaceId}:`)).some((s) =>
          s.projectId === id
        )
      ) return ok("in-use");
      await this.#storage.delete(`project:${workspaceId}:${id}`);
      return ok("deleted");
    });
  }

  listSecrets(workspaceId: WorkspaceId): ReturnType<WorkspaceRpc["listSecrets"]> {
    return this.#serialize(async () =>
      (await this.#values<Secret>(`secret:${workspaceId}:`)).sort((a, b) =>
        a.key.localeCompare(b.key)
      ).map(secretMetadata)
    );
  }

  getSecret(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceRpc["getSecret"]> {
    return this.#serialize(async () => {
      const secret = await this.#storage.get<Secret>(`secret:${workspaceId}:${id}`);
      return secret ? secretMetadata(secret) : null;
    });
  }

  getEnvironmentSecrets(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceRpc["getEnvironmentSecrets"]> {
    return this.#serialize(async () => {
      const secrets = await this.#values<Secret>(`secret:${workspaceId}:`);
      const values = await Promise.all(
        secrets.sort((a, b) => a.key.localeCompare(b.key)).map(async (s) => ({
          name: s.key,
          value: await this.#decrypt(s),
          ...(s.allowedHosts === undefined ? {} : { allowedHosts: s.allowedHosts }),
        })),
      );
      Schema.decodeUnknownSync(SessionEnvironmentSecrets)(values);
      return ok(values);
    });
  }

  saveSecret(
    workspaceId: WorkspaceId,
    id: string,
    value: string,
    allowedHosts?: readonly string[],
  ): ReturnType<WorkspaceRpc["saveSecret"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      const candidate = Schema.decodeUnknownSync(SessionEnvironmentSecret)({
        name: id,
        value,
        ...(allowedHosts === undefined ? {} : { allowedHosts }),
      });
      const key = `secret:${workspaceId}:${id}`;
      const existing = await this.#storage.get<Secret>(key);
      const others = (await this.#values<Secret>(`secret:${workspaceId}:`)).filter((s) =>
        s.key !== id
      );
      if (!existing && others.length >= MAX_SESSION_ENVIRONMENT_SECRETS) {
        return { status: "limit-exceeded" };
      }
      const values = await Promise.all(
        others.map(async (s) => ({
          name: s.key,
          value: await this.#decrypt(s),
          ...(s.allowedHosts === undefined ? {} : { allowedHosts: s.allowedHosts }),
        })),
      );
      if (
        Schema.decodeUnknownResult(SessionEnvironmentSecrets)([...values, candidate])._tag ===
          "Failure"
      ) return { status: "rpc-frame-limit-exceeded" };
      const secret = await this.#encrypt(workspaceId, id, candidate.value, existing);
      if (candidate.allowedHosts !== undefined) secret.allowedHosts = candidate.allowedHosts;
      await this.#storage.put(key, secret);
      return { status: "saved", secret: secretMetadata(secret) };
    });
  }

  deleteSecret(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceRpc["deleteSecret"]> {
    return this.#serialize(() => this.#storage.delete(`secret:${workspaceId}:${id}`));
  }

  listModelProviderCredentials(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceRpc["listModelProviderCredentials"]> {
    return this.#serialize(async () =>
      (await this.#values<Provider>(`provider:${workspaceId}:`)).sort((a, b) =>
        a.providerId.localeCompare(b.providerId)
      ).map((p) => this.#providerMetadata(p))
    );
  }

  getModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceRpc["getModelProviderCredential"]> {
    return this.#serialize(async () => {
      const provider = await this.#storage.get<Provider>(`provider:${workspaceId}:${id}`);
      return provider ? this.#providerMetadata(provider) : null;
    });
  }

  getModelProviderApiKey(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceRpc["getModelProviderApiKey"]> {
    return this.#serialize(async () => {
      const provider = await this.#storage.get<Provider>(`provider:${workspaceId}:${id}`);
      return ok(
        provider?.credentialType === "api_key" ? await this.#decrypt(provider.secret) : null,
      );
    });
  }

  saveModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
    apiKey: string,
  ): ReturnType<WorkspaceRpc["saveModelProviderCredential"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      if (id === "openai-codex") {
        await this.#storage.delete("oauth-login");
        await this.#storage.deleteAlarm();
      }
      return this.#saveProvider(workspaceId, id, apiKey);
    });
  }

  deleteModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceRpc["deleteModelProviderCredential"]> {
    return this.#serialize(async () => {
      if (id === "openai-codex") {
        await this.#storage.delete("oauth-login");
        await this.#storage.deleteAlarm();
      }
      return {
        status: await this.#storage.delete(`provider:${workspaceId}:${id}`)
          ? "deleted"
          : "not-found",
      };
    });
  }

  getGitAuthorConfiguration(userId: UserId): ReturnType<WorkspaceRpc["getGitAuthorConfiguration"]> {
    return this.#serialize(async () =>
      await this.#storage.get<GitAuthorConfiguration>(`git-author:${userId}`) ?? null
    );
  }

  saveGitAuthorConfiguration(
    ...[userId, input]: Parameters<WorkspaceRpc["saveGitAuthorConfiguration"]>
  ): ReturnType<WorkspaceRpc["saveGitAuthorConfiguration"]> {
    return this.#serialize(async () => {
      const administrator = await this.#storage.get<AdministratorRecord>("administrator");
      if (administrator?.userId !== userId) throw new Error("User not found");
      const value: GitAuthorConfiguration = { ...input, updatedAt: new Date().toISOString() };
      await this.#storage.put(`git-author:${userId}`, value);
      return value;
    });
  }

  getGitHubCredential(workspaceId: WorkspaceId): ReturnType<WorkspaceRpc["getGitHubCredential"]> {
    return this.#serialize(async () => {
      const value = await this.#storage.get<Provider>(`github:${workspaceId}`);
      return value
        ? {
          id: value.id,
          host: "github.com",
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
        }
        : null;
    });
  }

  getGitHubToken(workspaceId: WorkspaceId): ReturnType<WorkspaceRpc["getGitHubToken"]> {
    return this.#serialize(async () => {
      const value = await this.#storage.get<Provider>(`github:${workspaceId}`);
      return ok(value ? await this.#decrypt(value.secret) : null);
    });
  }

  saveGitHubCredential(
    workspaceId: WorkspaceId,
    token: string,
  ): ReturnType<WorkspaceRpc["saveGitHubCredential"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      const existing = await this.#storage.get<Provider>(`github:${workspaceId}`);
      const secret = await this.#encrypt(
        workspaceId,
        existing?.secret.key ?? crypto.randomUUID(),
        token,
        existing?.secret,
      );
      const value: Provider = {
        id: existing?.id ?? crypto.randomUUID(),
        providerId: "github",
        credentialType: "api_key",
        secret,
        createdAt: existing?.createdAt ?? secret.createdAt,
        updatedAt: secret.updatedAt,
      };
      await this.#storage.put(`github:${workspaceId}`, value);
      return {
        id: value.id,
        host: "github.com",
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      };
    });
  }

  deleteGitHubCredential(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceRpc["deleteGitHubCredential"]> {
    return this.#serialize(async () => {
      return {
        status: await this.#storage.delete(`github:${workspaceId}`) ? "deleted" : "not-found",
      };
    });
  }

  getRunnerEnrollmentToken(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceRpc["getRunnerEnrollmentToken"]> {
    return this.#serialize(() => this.#enrollmentToken(workspaceId, false));
  }

  regenerateRunnerEnrollmentToken(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceRpc["regenerateRunnerEnrollmentToken"]> {
    return this.#serialize(() => this.#enrollmentToken(workspaceId, true));
  }

  async #enrollmentToken(
    workspaceId: WorkspaceId,
    rotate: boolean,
  ): ReturnType<WorkspaceRpc["getRunnerEnrollmentToken"]> {
    await this.#requireWorkspace(workspaceId);
    const key = `enrollment:${workspaceId}`;
    let enrollment = await this.#storage.get<Enrollment>(key);
    if (!enrollment || rotate) {
      const token = generateRunnerSecret(ENROLLMENT_PSK_PREFIX);
      enrollment = {
        id: v7.generate(),
        token,
        tokenHash: await hashRunnerSecret(token),
        createdAt: new Date().toISOString(),
      };
      await this.#storage.put(key, enrollment);
    }
    return { id: enrollment.id, token: enrollment.token, createdAt: enrollment.createdAt };
  }

  enrollRunner(input: RunnerEnrollmentRequest): ReturnType<WorkspaceRpc["enrollRunner"]> {
    return this.#serialize(async () => {
      if (input.architecture !== "x64" && input.architecture !== "arm64") {
        throw new Error("Invalid architecture");
      }
      Schema.decodeUnknownSync(Schema.NonEmptyString.check(Schema.isMaxLength(100)))(
        input.name.trim(),
      );
      const administrator = await this.#storage.get<AdministratorRecord>("administrator");
      if (!administrator) return null;
      const enrollment = await this.#storage.get<Enrollment>(
        `enrollment:${administrator.workspaceId}`,
      );
      if (!enrollment || enrollment.tokenHash !== await hashRunnerSecret(input.enrollmentPsk)) {
        return null;
      }
      const token = generateRunnerSecret(RUNNER_TOKEN_PREFIX);
      const runner: Runner = {
        id: v7.generate(),
        workspaceId: administrator.workspaceId,
        name: input.name.trim(),
        architecture: input.architecture,
        tokenHash: await hashRunnerSecret(token),
        createdAt: new Date().toISOString(),
        revokedAt: null,
      };
      await this.#storage.put(`runner:${runner.workspaceId}:${runner.id}`, runner);
      return { runnerId: runner.id, runnerToken: token };
    });
  }

  authenticateRunner(token: string): ReturnType<WorkspaceRpc["authenticateRunner"]> {
    return this.#serialize(async () => {
      const hash = await hashRunnerSecret(token);
      const runner = (await this.#values<Runner>("runner:")).find((r) =>
        r.tokenHash === hash && r.revokedAt === null
      );
      return runner ? { id: runner.id, workspaceId: runner.workspaceId } : null;
    });
  }

  listRunners(workspaceId: WorkspaceId): ReturnType<WorkspaceRpc["listRunners"]> {
    return this.#serialize(async () =>
      (await this.#values<Runner>(`runner:${workspaceId}:`)).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      ).map(({ tokenHash: _hash, workspaceId: _workspace, ...r }) => r)
    );
  }

  revokeRunner(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceRpc["revokeRunner"]> {
    return this.#serialize(async () => {
      const key = `runner:${workspaceId}:${id}`;
      const runner = await this.#storage.get<Runner>(key);
      if (!runner) return "not-found";
      runner.revokedAt ??= new Date().toISOString();
      await this.#storage.put(key, runner);
      return "revoked";
    });
  }

  deleteRunner(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceRpc["deleteRunner"]> {
    return this.#serialize(async () => {
      const key = `runner:${workspaceId}:${id}`;
      const runner = await this.#storage.get<Runner>(key);
      if (!runner) return "not-found";
      if (runner.revokedAt === null) return "not-revoked";
      await this.#storage.delete(key);
      return "deleted";
    });
  }

  listSessionNavigationEntries(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceRpc["listSessionNavigationEntries"]> {
    return this.#serialize(async () => {
      const entries = await this.#values<SessionCatalogEntry>(`session:${workspaceId}:`);
      return Promise.all(
        entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(async (entry) => {
          const project = await this.#storage.get<Project>(
            `project:${workspaceId}:${entry.projectId}`,
          );
          if (!project) throw new Error("Missing project");
          return {
            id: entry.id,
            projectId: entry.projectId,
            projectName: project.name,
            initialPromptPreview: entry.initialPromptPreview,
          };
        }),
      );
    });
  }

  getSessionCatalogEntry(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceRpc["getSessionCatalogEntry"]> {
    return this.#serialize(async () =>
      await this.#storage.get<SessionCatalogEntry>(`session:${workspaceId}:${id}`) ?? null
    );
  }

  deleteSessionCatalogEntry(
    workspaceId: WorkspaceId,
    id: string,
    deletedAt: string,
  ): ReturnType<WorkspaceRpc["deleteSessionCatalogEntry"]> {
    return this.#serialize(() =>
      this.#storage.transaction(async (storage) => {
        if (!await storage.get(`session:${workspaceId}:${id}`)) return ok("not-found");
        await storage.put(`deleted:${workspaceId}:${id}`, deletedAt);
        await storage.delete(`session:${workspaceId}:${id}`);
        return ok("deleted");
      })
    );
  }

  reconcileSessionManifestEntries(
    workspaceId: WorkspaceId,
    entries: readonly SessionCatalogEntry[],
  ): ReturnType<WorkspaceRpc["reconcileSessionManifestEntries"]> {
    return this.#serialize(async () => {
      const result: ReconciledSessionManifest = {
        acceptedSessionIds: [],
        tombstonedSessionIds: [],
        rejected: [],
      };
      const pending = new Map<string, SessionCatalogEntry>();
      for (const entry of entries) {
        if (await this.#storage.get(`deleted:${workspaceId}:${entry.id}`) !== undefined) {
          result.tombstonedSessionIds.push(entry.id);
          continue;
        }
        const existing = await this.#storage.get<SessionCatalogEntry>(
          `session:${workspaceId}:${entry.id}`,
        ) ?? pending.get(entry.id);
        if (
          existing &&
          (existing.projectId !== entry.projectId || existing.createdAt !== entry.createdAt ||
            existing.initialPromptPreview !== entry.initialPromptPreview)
        ) {
          result.rejected.push({ sessionId: entry.id, reason: "catalog-conflict" });
        } else if (!await this.#storage.get(`project:${workspaceId}:${entry.projectId}`)) {
          result.rejected.push({ sessionId: entry.id, reason: "project-not-found" });
        } else {
          result.acceptedSessionIds.push(entry.id);
          pending.set(entry.id, {
            id: entry.id,
            projectId: entry.projectId,
            createdAt: entry.createdAt,
            initialPromptPreview: entry.initialPromptPreview,
          });
        }
      }
      if (result.rejected.length) return ok({ ...result, acceptedSessionIds: [] });
      await this.#storage.transaction(async (storage) => {
        for (const entry of pending.values()) {
          await storage.put(`session:${workspaceId}:${entry.id}`, entry);
        }
      });
      return ok(result);
    });
  }

  startProviderLogin(workspaceId: WorkspaceId): ReturnType<WorkspaceRpc["startProviderLogin"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      const login = await startDeviceLogin();
      await this.#storage.transaction(async (storage) => {
        await storage.put<Login>("oauth-login", { status: "pending", login });
        await storage.setAlarm(login.nextPollAt);
      });
      return loginPublic(login);
    });
  }

  getProviderLoginStatus(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceRpc["getProviderLoginStatus"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      const state = await this.#storage.get<Login>("oauth-login");
      if (!state || (state.status === "pending" ? state.login.id : state.id) !== id) {
        return { status: "missing" };
      }
      return state.status === "pending"
        ? { status: "pending", authorization: loginPublic(state.login) }
        : { status: state.status };
    });
  }

  cancelProviderLogin(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceRpc["cancelProviderLogin"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      const state = await this.#storage.get<Login>("oauth-login");
      if (state && (state.status === "pending" ? state.login.id : state.id) === id) {
        await this.#storage.delete("oauth-login");
        await this.#storage.deleteAlarm();
      }
      return;
    });
  }

  disconnectProvider(workspaceId: WorkspaceId): ReturnType<WorkspaceRpc["disconnectProvider"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      await this.#storage.delete("oauth-login");
      await this.#storage.deleteAlarm();
      const key = `provider:${workspaceId}:openai-codex`;
      const provider = await this.#storage.get<Provider>(key);
      if (!provider) return { status: "not-found" };
      if (provider.credentialType === "oauth") {
        // SAFETY: only validated provider responses create this encrypted OAuth record.
        const credential = JSON.parse(await this.#decrypt(provider.secret)) as OAuthCredential;
        await revokeOAuthCredential(credential).catch(() => {});
      }
      await this.#storage.delete(key);
      return { status: "deleted" };
    });
  }

  resolveProviderAccessToken(
    workspaceId: WorkspaceId,
    _now?: number,
  ): ReturnType<WorkspaceRpc["resolveProviderAccessToken"]> {
    return this.#serialize(async () => {
      await this.#requireWorkspace(workspaceId);
      const key = `provider:${workspaceId}:openai-codex`;
      const provider = await this.#storage.get<Provider>(key);
      if (provider?.credentialType !== "oauth") return null;
      // SAFETY: only validated provider responses create this encrypted OAuth record.
      let credential = JSON.parse(await this.#decrypt(provider.secret)) as OAuthCredential;
      if (credential.expires <= Date.now() + 300_000) {
        credential = await refreshOAuthCredential(credential);
        await this.#saveProvider(workspaceId, "openai-codex", credential);
      }
      return credential.access;
    });
  }

  readBrowserSession(id: string): ReturnType<WorkspaceRpc["readBrowserSession"]> {
    return this.#serialize(async () => {
      const session = await this.#storage.get<BrowserSessionRecord>(`browser:${id}`);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) {
        await this.#storage.delete(`browser:${id}`);
        return null;
      }
      return session;
    });
  }

  saveBrowserSession(input: SaveBrowserSession): ReturnType<WorkspaceRpc["saveBrowserSession"]> {
    return this.#serialize(() => this.#saveBrowserSession(input));
  }

  deleteBrowserSessions(ids: string[]): ReturnType<WorkspaceRpc["deleteBrowserSessions"]> {
    return this.#serialize(async () => {
      for (const sessionId of ids) {
        await this.#storage.delete(`browser:${sessionId}`);
      }
      return;
    });
  }

  async #saveBrowserSession(input: SaveBrowserSession): Promise<boolean> {
    // ponytail: scan a single workspace's browser sessions; add indexed expiry cleanup if this grows.
    for (
      const [key, record] of await this.#storage.list<BrowserSessionRecord>({ prefix: "browser:" })
    ) {
      if (record.expiresAt <= Date.now()) await this.#storage.delete(key);
    }
    const values = input.data[0];
    const identity = "auth" in values ? parseBrowserSessionAuth(values.auth) : undefined;
    if ("auth" in values && !identity) throw new Error("Invalid session identity");
    if (identity) {
      const administrator = await this.#storage.get<AdministratorRecord>("administrator");
      if (
        identity.userId !== administrator?.userId ||
        identity.workspaceId !== administrator.workspaceId
      ) throw new Error("Unknown session identity");
    }
    const record: BrowserSessionRecord = {
      data: input.data,
      userId: identity?.userId ?? null,
      workspaceId: identity?.workspaceId ?? null,
      expiresAt: Date.now() + BROWSER_SESSION_MAX_AGE_SECONDS * 1000,
    };
    return this.#storage.transaction(async (storage) => {
      const key = `browser:${input.id}`;
      if (input.mode === "update" || input.mode === "rotate") {
        const previousKey = input.mode === "rotate" ? `browser:${input.previousId}` : key;
        const previous = await storage.get<BrowserSessionRecord>(previousKey);
        if (!previous || previous.expiresAt <= Date.now()) return false;
        if (
          input.mode === "update" &&
          (previous.userId !== record.userId || previous.workspaceId !== record.workspaceId)
        ) return false;
        if (input.mode === "rotate") await storage.delete(previousKey);
      } else if (await storage.get(key)) throw new Error("Session already exists");
      await storage.put(key, record);
      return true;
    });
  }
}

function secretMetadata(secret: Secret) {
  return {
    key: secret.key,
    keyVersion: secret.keyVersion,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    ...(secret.allowedHosts === undefined ? {} : { allowedHosts: secret.allowedHosts }),
  };
}

function loginPublic(login: DeviceLogin) {
  return {
    id: login.id,
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    intervalSeconds: Math.max(1, login.intervalSeconds),
  };
}
