import { DurableObject } from "cloudflare:workers";
import type { SqlStorageValue } from "@cloudflare/workers-types";
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
import { hashPassword, type PasswordHash, verifyPassword } from "../../utils/password.ts";
import { loadMasterKey, type MasterKey } from "../../utils/master-key.ts";
import { decryptSecret, type EncryptedSecret, encryptSecret } from "../../utils/secret-cipher.ts";
import { generateRunnerSecret, hashRunnerSecret } from "../../utils/runner-token.ts";
import {
  BROWSER_SESSION_MAX_AGE_SECONDS,
  parseBrowserSessionAuth,
} from "../../utils/session-policy.ts";
import type { Env } from "../../env.ts";
import {
  type BrowserSessionRecord,
  decodeWorkspaceArguments,
  type GitAuthorConfiguration,
  type Project,
  type ReconciledSessionManifest,
  type SaveBrowserSession,
  type SaveProjectInput,
  type SessionCatalogEntry,
  type WorkspaceApi,
} from "./api.ts";
import {
  type DeviceLogin,
  type OAuthCredential,
  pollDeviceLogin,
  refreshOAuthCredential,
  revokeOAuthCredential,
  startDeviceLogin,
} from "./oauth.ts";
import { migrateWorkspaceDatabase, workspaceMigrations } from "./migrations.ts";
import type {
  BrowserSessionRow,
  EncryptedSecretRow,
  ModelProviderCredentialRow,
  PasswordCredential,
  ProjectRow,
  ProviderAuthorizationRow,
  RunnerEnrollmentTokenRow,
  RunnerRow,
  User,
} from "./schema.ts";

/** Native SQLite-backed DO storage; no host database or filesystem adapter. */
export interface WorkspaceStorage {
  sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, SqlStorageValue>[] };
  };
  transactionSync<T>(callback: () => T): T;
  transaction<T>(
    callback: (storage: Pick<WorkspaceStorage, "setAlarm" | "deleteAlarm">) => Promise<T>,
  ): Promise<T>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  sync(): Promise<void>;
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

type SecretRow = Omit<EncryptedSecretRow, "purpose">;

interface Provider extends Omit<ModelProviderCredentialRow, "workspaceId" | "secretKey"> {
  secret: Secret;
}

type ProviderRow = Omit<Provider, "secret"> & SecretRow;

type Enrollment = Omit<RunnerEnrollmentTokenRow, "workspaceId">;

type Login =
  | { status: "pending"; login: DeviceLogin }
  | { status: "complete" | "error"; id: string };

/** One configuration owner. Runner connections and agent sessions remain outside this object. */
export class Workspace extends DurableObject<Env> implements WorkspaceApi {
  readonly #storage: WorkspaceStorage;
  readonly #masterKey: Promise<MasterKey>;
  readonly #ready: Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    context: {
      storage: WorkspaceStorage;
      blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
    },
    environment: Env,
  ) {
    super(context, environment);
    this.#storage = context.storage;
    this.#masterKey = loadMasterKey(environment.OPENORB_MASTER_KEY);
    this.#rows("PRAGMA foreign_keys = ON");
    this.#ready = context.blockConcurrencyWhile(async () => {
      await migrateWorkspaceDatabase(this.#storage, workspaceMigrations);
    });
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    // ponytail: one configuration queue; split hot session/runner traffic into their own DOs later.
    const result = this.#tail.catch(() => {}).then(async () => {
      await this.#ready;
      return operation();
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  async health(): Promise<void> {
    await this.#ready;
    await this.#masterKey;
  }

  alarm(): Promise<void> {
    return this.#pollLogin();
  }

  #rows<T>(query: string, ...bindings: unknown[]): T[] {
    // SAFETY: Queries below select the columns of their declared, locally-owned row type.
    return this.#storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  #requireWorkspace(workspaceId: WorkspaceId): void {
    if (!this.#rows("SELECT id FROM workspaces WHERE id = ?", workspaceId).length) {
      throw new Error("Workspace not found");
    }
  }

  #administrator(): AdministratorRecord | undefined {
    const row = this.#rows<PasswordCredential & Pick<User, "workspaceId">>(`
      SELECT u.id AS userId, u.workspaceId, p.* FROM users u
      JOIN password_credentials p ON p.userId = u.id WHERE u.isAdministrator = 1
    `)[0];
    return row && {
      userId: row.userId,
      workspaceId: WorkspaceIdSchema.make(row.workspaceId),
      // SAFETY: Only hashPassword writes the algorithm parameters of this private row.
      password: {
        salt: new Uint8Array(row.salt),
        derivedKey: new Uint8Array(row.derivedKey),
        algorithm: row.algorithm,
        hash: row.hash,
        iterations: row.iterations,
        keyLengthBits: row.keyLengthBits,
      } as PasswordHash,
    };
  }

  #secrets(workspaceId: WorkspaceId): Secret[] {
    return this.#rows<SecretRow>(
      `
      SELECT key, workspaceId, keyVersion, ciphertext, allowedHosts, createdAt, updatedAt
      FROM encrypted_secrets WHERE workspaceId = ? AND purpose = 'generic-secret'
    `,
      workspaceId,
    ).map(secretFromRow).sort((a, b) => a.key.localeCompare(b.key));
  }

  #secret(workspaceId: WorkspaceId, key: string): Secret | undefined {
    const row = this.#rows<SecretRow>(
      `
      SELECT key, workspaceId, keyVersion, ciphertext, allowedHosts, createdAt, updatedAt
      FROM encrypted_secrets WHERE workspaceId = ? AND key = ? AND purpose = 'generic-secret'
    `,
      workspaceId,
      key,
    )[0];
    return row && secretFromRow(row);
  }

  #writeSecret(secret: Secret, purpose: EncryptedSecretRow["purpose"]): void {
    this.#rows(
      `
      INSERT INTO encrypted_secrets
        (workspaceId, key, purpose, keyVersion, ciphertext, allowedHosts, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspaceId, key) DO UPDATE SET
        keyVersion = excluded.keyVersion, ciphertext = excluded.ciphertext,
        purpose = excluded.purpose, allowedHosts = excluded.allowedHosts, updatedAt = excluded.updatedAt
    `,
      secret.workspaceId,
      secret.key,
      purpose,
      secret.keyVersion,
      Uint8Array.from(secret.ciphertext).buffer,
      secret.allowedHosts === undefined ? null : JSON.stringify(secret.allowedHosts),
      secret.createdAt,
      secret.updatedAt,
    );
  }

  #provider(workspaceId: WorkspaceId, providerId: string): Provider | undefined {
    const row = this.#rows<ProviderRow>(
      `
      SELECT p.id, p.providerId, p.credentialType, s.key, s.workspaceId, s.keyVersion,
        s.ciphertext, s.allowedHosts, p.createdAt, p.updatedAt
      FROM model_provider_credentials p JOIN encrypted_secrets s
        ON s.workspaceId = p.workspaceId AND s.key = p.secretKey
      WHERE p.workspaceId = ? AND p.providerId = ?
    `,
      workspaceId,
      providerId,
    )[0];
    return row && providerFromRow(row);
  }

  #gitCredential(workspaceId: WorkspaceId): Provider | undefined {
    const row = this.#rows<ProviderRow>(
      `
      SELECT g.id, 'github' AS providerId, 'api_key' AS credentialType, s.key, s.workspaceId,
        s.keyVersion, s.ciphertext, s.allowedHosts, g.createdAt, g.updatedAt
      FROM git_credentials g JOIN encrypted_secrets s
        ON s.workspaceId = g.workspaceId AND s.key = g.secretKey
      WHERE g.workspaceId = ? AND g.host = 'github.com'
    `,
      workspaceId,
    )[0];
    return row && providerFromRow(row);
  }

  #login(): Login | undefined {
    const row = this.#rows<Pick<ProviderAuthorizationRow, "id" | "status" | "login">>(
      "SELECT id, status, login FROM provider_authorizations",
    )[0];
    if (!row) return;
    // SAFETY: Only validated provider responses write the private device checkpoint.
    return row.status === "pending"
      ? { status: "pending", login: JSON.parse(row.login!) as DeviceLogin }
      : { status: row.status, id: row.id };
  }

  #writeLogin(workspaceId: WorkspaceId, login: Login): void {
    this.#rows(
      `
      INSERT INTO provider_authorizations (workspaceId, id, status, login) VALUES (?, ?, ?, ?)
      ON CONFLICT (workspaceId) DO UPDATE SET id = excluded.id, status = excluded.status,
        login = excluded.login
    `,
      workspaceId,
      login.status === "pending" ? login.login.id : login.id,
      login.status,
      login.status === "pending" ? JSON.stringify(login.login) : null,
    );
  }

  async #clearLogin(workspaceId: WorkspaceId): Promise<void> {
    await this.#storage.transaction(async (storage) => {
      this.#rows("DELETE FROM provider_authorizations WHERE workspaceId = ?", workspaceId);
      await storage.deleteAlarm();
    });
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
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(providerId)) throw new Error("Invalid provider");
    const existing = this.#provider(workspaceId, providerId);
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
    this.#storage.transactionSync(() => {
      this.#writeSecret(
        secret,
        provider.credentialType === "oauth" ? "provider-oauth" : "provider-api-key",
      );
      this.#rows(
        `
        INSERT INTO model_provider_credentials
          (workspaceId, id, providerId, credentialType, secretKey, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspaceId, providerId) DO UPDATE SET
          credentialType = excluded.credentialType, updatedAt = excluded.updatedAt
      `,
        workspaceId,
        provider.id,
        providerId,
        provider.credentialType,
        secret.key,
        provider.createdAt,
        provider.updatedAt,
      );
    });
    return this.#providerMetadata(provider);
  }

  async #pollLogin(): Promise<void> {
    const state = await this.#serialize(() => this.#login());
    if (!state || state.status !== "pending") return;
    const result = await pollDeviceLogin(state.login);
    await this.#serialize(async () => {
      const current = this.#login();
      if (current?.status !== "pending" || current.login.id !== state.login.id) return;
      const administrator = this.#administrator();
      if (!administrator) throw new Error("Workspace not found");
      await this.#storage.transaction(async (storage) => {
        if (result.status === "pending") {
          this.#writeLogin(administrator.workspaceId, result);
          await storage.setAlarm(result.login.nextPollAt);
        } else {
          if (result.status === "complete") {
            await this.#saveProvider(
              administrator.workspaceId,
              "openai-codex",
              result.credential,
            );
          }
          this.#writeLogin(administrator.workspaceId, {
            status: result.status,
            id: state.login.id,
          });
          await storage.deleteAlarm();
        }
      });
    });
  }

  hasAdministrator(): ReturnType<WorkspaceApi["hasAdministrator"]> {
    return this.#serialize(() =>
      this.#rows("SELECT id FROM users WHERE isAdministrator = 1").length !== 0
    );
  }

  getAdministrator(userId: UserId): ReturnType<WorkspaceApi["getAdministrator"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getAdministrator", [userId]);
      return this.#rows<{ userId: UserId; workspaceId: WorkspaceId }>(
        "SELECT id AS userId, workspaceId FROM users WHERE id = ? AND isAdministrator = 1",
        userId,
      )[0] ?? null;
    });
  }

  createAdministrator(input: string): ReturnType<WorkspaceApi["createAdministrator"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("createAdministrator", [input]);
      const password = await hashPassword(input);
      return this.#storage.transactionSync(() => {
        if (this.#rows("SELECT id FROM users WHERE isAdministrator = 1").length) return ok(false);
        const userId = v7.generate();
        const workspaceId = WorkspaceIdSchema.make(v7.generate());
        const now = new Date().toISOString();
        this.#rows(
          "INSERT INTO workspaces (id, singleton, createdAt) VALUES (?, 1, ?)",
          workspaceId,
          now,
        );
        this.#rows(
          "INSERT INTO users (id, workspaceId, isAdministrator, createdAt) VALUES (?, ?, 1, ?)",
          userId,
          workspaceId,
          now,
        );
        this.#rows(
          `
          INSERT INTO password_credentials
            (userId, salt, derivedKey, algorithm, hash, iterations, keyLengthBits)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          userId,
          Uint8Array.from(password.salt).buffer,
          Uint8Array.from(password.derivedKey).buffer,
          password.algorithm,
          password.hash,
          password.iterations,
          password.keyLengthBits,
        );
        return ok(true);
      });
    });
  }

  verifyAdministratorPassword(
    password: string,
  ): ReturnType<WorkspaceApi["verifyAdministratorPassword"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("verifyAdministratorPassword", [password]);
      const administrator = this.#administrator();
      if (
        !administrator || !await verifyPassword(password, administrator.password)
      ) return null;
      return { userId: UserId.make(administrator.userId), workspaceId: administrator.workspaceId };
    });
  }

  listProjects(workspaceId: WorkspaceId): ReturnType<WorkspaceApi["listProjects"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("listProjects", [workspaceId]);
      return this.#rows<Project>(
        `
        SELECT id, name, repositoryUrl, defaultRef, defaultBranchPattern, createdAt, updatedAt
        FROM projects WHERE workspaceId = ?
      `,
        workspaceId,
      ).sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  getProject(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceApi["getProject"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getProject", [workspaceId, id]);
      return this.#rows<Project>(
        `
        SELECT id, name, repositoryUrl, defaultRef, defaultBranchPattern, createdAt, updatedAt
        FROM projects WHERE workspaceId = ? AND id = ?
      `,
        workspaceId,
        id,
      )[0] ?? null;
    });
  }

  saveProject(
    workspaceId: WorkspaceId,
    input: SaveProjectInput,
  ): ReturnType<WorkspaceApi["saveProject"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("saveProject", [workspaceId, input]);
      this.#requireWorkspace(workspaceId);
      const existing = input.id
        ? this.#rows<Pick<ProjectRow, "id" | "createdAt">>(
          "SELECT id, createdAt FROM projects WHERE workspaceId = ? AND id = ?",
          workspaceId,
          input.id,
        )[0]
        : undefined;
      if (input.id && !existing) return { status: "not-found" };
      if (
        this.#rows(
          "SELECT id FROM projects WHERE workspaceId = ? AND name = ? AND id != ?",
          workspaceId,
          input.name,
          input.id ?? "",
        ).length
      ) {
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
      this.#rows(
        `
        INSERT INTO projects
          (workspaceId, id, name, repositoryUrl, defaultRef, defaultBranchPattern, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspaceId, id) DO UPDATE SET name = excluded.name,
          repositoryUrl = excluded.repositoryUrl, defaultRef = excluded.defaultRef,
          defaultBranchPattern = excluded.defaultBranchPattern, updatedAt = excluded.updatedAt
      `,
        workspaceId,
        project.id,
        project.name,
        project.repositoryUrl,
        project.defaultRef,
        project.defaultBranchPattern,
        project.createdAt,
        project.updatedAt,
      );
      return { status: "saved", project };
    });
  }

  deleteProject(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceApi["deleteProject"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("deleteProject", [workspaceId, id]);
      if (
        !this.#rows("SELECT id FROM projects WHERE workspaceId = ? AND id = ?", workspaceId, id)
          .length
      ) return ok("not-found");
      if (
        this.#rows(
          "SELECT id FROM sessions WHERE workspaceId = ? AND projectId = ? LIMIT 1",
          workspaceId,
          id,
        ).length
      ) return ok("in-use");
      this.#rows("DELETE FROM projects WHERE workspaceId = ? AND id = ?", workspaceId, id);
      return ok("deleted");
    });
  }

  listSecrets(workspaceId: WorkspaceId): ReturnType<WorkspaceApi["listSecrets"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("listSecrets", [workspaceId]);
      return this.#secrets(workspaceId).map(secretMetadata);
    });
  }

  getSecret(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceApi["getSecret"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getSecret", [workspaceId, id]);
      const secret = this.#secret(workspaceId, id);
      return secret ? secretMetadata(secret) : null;
    });
  }

  getEnvironmentSecrets(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceApi["getEnvironmentSecrets"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("getEnvironmentSecrets", [workspaceId]);
      const secrets = this.#secrets(workspaceId);
      const values = await Promise.all(
        secrets.map(async (s) => ({
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
  ): ReturnType<WorkspaceApi["saveSecret"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("saveSecret", [workspaceId, id, value, allowedHosts]);
      this.#requireWorkspace(workspaceId);
      const candidate = Schema.decodeUnknownSync(SessionEnvironmentSecret)({
        name: id,
        value,
        ...(allowedHosts === undefined ? {} : { allowedHosts }),
      });
      const existing = this.#secret(workspaceId, id);
      const others = this.#secrets(workspaceId).filter((s) => s.key !== id);
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
      this.#writeSecret(secret, "generic-secret");
      return { status: "saved", secret: secretMetadata(secret) };
    });
  }

  deleteSecret(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceApi["deleteSecret"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("deleteSecret", [workspaceId, id]);
      return this.#rows(
        `DELETE FROM encrypted_secrets
        WHERE workspaceId = ? AND key = ? AND purpose = 'generic-secret' RETURNING key`,
        workspaceId,
        id,
      ).length !== 0;
    });
  }

  listModelProviderCredentials(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceApi["listModelProviderCredentials"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("listModelProviderCredentials", [workspaceId]);
      return this.#rows<Omit<Provider, "secret">>(
        `
        SELECT id, providerId, credentialType, createdAt, updatedAt
        FROM model_provider_credentials WHERE workspaceId = ?
      `,
        workspaceId,
      ).sort((a, b) => a.providerId.localeCompare(b.providerId));
    });
  }

  getModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceApi["getModelProviderCredential"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getModelProviderCredential", [workspaceId, id]);
      return this.#rows<Omit<Provider, "secret">>(
        `
        SELECT id, providerId, credentialType, createdAt, updatedAt
        FROM model_provider_credentials WHERE workspaceId = ? AND providerId = ?
      `,
        workspaceId,
        id,
      )[0] ?? null;
    });
  }

  getModelProviderApiKey(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceApi["getModelProviderApiKey"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("getModelProviderApiKey", [workspaceId, id]);
      const provider = this.#provider(workspaceId, id);
      return ok(
        provider?.credentialType === "api_key" ? await this.#decrypt(provider.secret) : null,
      );
    });
  }

  saveModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
    apiKey: string,
  ): ReturnType<WorkspaceApi["saveModelProviderCredential"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("saveModelProviderCredential", [workspaceId, id, apiKey]);
      this.#requireWorkspace(workspaceId);
      return this.#storage.transaction(async () => {
        if (id === "openai-codex") await this.#clearLogin(workspaceId);
        return this.#saveProvider(workspaceId, id, apiKey);
      });
    });
  }

  deleteModelProviderCredential(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceApi["deleteModelProviderCredential"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("deleteModelProviderCredential", [workspaceId, id]);
      if (!this.#rows("SELECT id FROM workspaces WHERE id = ?", workspaceId).length) {
        return { status: "not-found" };
      }
      return this.#storage.transaction(async () => {
        if (id === "openai-codex") await this.#clearLogin(workspaceId);
        return {
          status: this.#rows(
              `DELETE FROM encrypted_secrets
          WHERE workspaceId = ? AND key = (
            SELECT secretKey FROM model_provider_credentials WHERE workspaceId = ? AND providerId = ?
          ) RETURNING key`,
              workspaceId,
              workspaceId,
              id,
            ).length
            ? "deleted"
            : "not-found",
        };
      });
    });
  }

  getGitAuthorConfiguration(userId: UserId): ReturnType<WorkspaceApi["getGitAuthorConfiguration"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getGitAuthorConfiguration", [userId]);
      return this.#rows<GitAuthorConfiguration>(
        `
        SELECT authorName, authorEmail, updatedAt FROM git_author_configuration WHERE userId = ?
      `,
        userId,
      )[0] ?? null;
    });
  }

  saveGitAuthorConfiguration(
    ...[userId, input]: Parameters<WorkspaceApi["saveGitAuthorConfiguration"]>
  ): ReturnType<WorkspaceApi["saveGitAuthorConfiguration"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("saveGitAuthorConfiguration", [userId, input]);
      if (!this.#rows("SELECT id FROM users WHERE id = ? AND isAdministrator = 1", userId).length) {
        throw new Error("User not found");
      }
      const value: GitAuthorConfiguration = { ...input, updatedAt: new Date().toISOString() };
      this.#rows(
        `
        INSERT INTO git_author_configuration (userId, authorName, authorEmail, updatedAt) VALUES (?, ?, ?, ?)
        ON CONFLICT (userId) DO UPDATE SET authorName = excluded.authorName,
          authorEmail = excluded.authorEmail, updatedAt = excluded.updatedAt
      `,
        userId,
        value.authorName,
        value.authorEmail,
        value.updatedAt,
      );
      return value;
    });
  }

  getGitHubCredential(workspaceId: WorkspaceId): ReturnType<WorkspaceApi["getGitHubCredential"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getGitHubCredential", [workspaceId]);
      return this.#rows<{ id: string; host: "github.com"; createdAt: string; updatedAt: string }>(
        `
        SELECT id, host, createdAt, updatedAt FROM git_credentials WHERE workspaceId = ? AND host = 'github.com'
      `,
        workspaceId,
      )[0] ?? null;
    });
  }

  getGitHubToken(workspaceId: WorkspaceId): ReturnType<WorkspaceApi["getGitHubToken"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("getGitHubToken", [workspaceId]);
      const value = this.#gitCredential(workspaceId);
      return ok(value ? await this.#decrypt(value.secret) : null);
    });
  }

  saveGitHubCredential(
    workspaceId: WorkspaceId,
    token: string,
  ): ReturnType<WorkspaceApi["saveGitHubCredential"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("saveGitHubCredential", [workspaceId, token]);
      this.#requireWorkspace(workspaceId);
      const existing = this.#gitCredential(workspaceId);
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
      this.#storage.transactionSync(() => {
        this.#writeSecret(secret, "git-credential");
        this.#rows(
          `
          INSERT INTO git_credentials (workspaceId, id, host, secretKey, createdAt, updatedAt)
          VALUES (?, ?, 'github.com', ?, ?, ?)
          ON CONFLICT (workspaceId, host) DO UPDATE SET updatedAt = excluded.updatedAt
        `,
          workspaceId,
          value.id,
          secret.key,
          value.createdAt,
          value.updatedAt,
        );
      });
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
  ): ReturnType<WorkspaceApi["deleteGitHubCredential"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("deleteGitHubCredential", [workspaceId]);
      return {
        status: this.#rows(
            `DELETE FROM encrypted_secrets
          WHERE workspaceId = ? AND key = (
            SELECT secretKey FROM git_credentials WHERE workspaceId = ? AND host = 'github.com'
          ) RETURNING key`,
            workspaceId,
            workspaceId,
          ).length
          ? "deleted"
          : "not-found",
      };
    });
  }

  getRunnerEnrollmentToken(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceApi["getRunnerEnrollmentToken"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getRunnerEnrollmentToken", [workspaceId]);
      return this.#enrollmentToken(workspaceId, false);
    });
  }

  regenerateRunnerEnrollmentToken(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceApi["regenerateRunnerEnrollmentToken"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("regenerateRunnerEnrollmentToken", [workspaceId]);
      return this.#enrollmentToken(workspaceId, true);
    });
  }

  async #enrollmentToken(
    workspaceId: WorkspaceId,
    rotate: boolean,
  ): ReturnType<WorkspaceApi["getRunnerEnrollmentToken"]> {
    this.#requireWorkspace(workspaceId);
    let enrollment = this.#rows<Enrollment>(
      "SELECT id, token, tokenHash, createdAt FROM runner_enrollment_tokens WHERE workspaceId = ?",
      workspaceId,
    )[0];
    if (!enrollment || rotate) {
      const token = generateRunnerSecret(ENROLLMENT_PSK_PREFIX);
      enrollment = {
        id: v7.generate(),
        token,
        tokenHash: await hashRunnerSecret(token),
        createdAt: new Date().toISOString(),
      };
      this.#rows(
        `
        INSERT INTO runner_enrollment_tokens (workspaceId, id, token, tokenHash, createdAt) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (workspaceId) DO UPDATE SET id = excluded.id, token = excluded.token,
          tokenHash = excluded.tokenHash, createdAt = excluded.createdAt
      `,
        workspaceId,
        enrollment.id,
        enrollment.token,
        enrollment.tokenHash,
        enrollment.createdAt,
      );
    }
    return { id: enrollment.id, token: enrollment.token, createdAt: enrollment.createdAt };
  }

  enrollRunner(
    input: Parameters<WorkspaceApi["enrollRunner"]>[0],
  ): ReturnType<WorkspaceApi["enrollRunner"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("enrollRunner", [input]);
      if (input.architecture !== "x64" && input.architecture !== "arm64") {
        throw new Error("Invalid architecture");
      }
      Schema.decodeUnknownSync(Schema.NonEmptyString.check(Schema.isMaxLength(100)))(
        input.name.trim(),
      );
      const enrollment = this.#rows<{ workspaceId: WorkspaceId }>(
        "SELECT workspaceId FROM runner_enrollment_tokens WHERE tokenHash = ?",
        await hashRunnerSecret(input.enrollmentPsk),
      )[0];
      if (!enrollment) return null;
      const token = generateRunnerSecret(RUNNER_TOKEN_PREFIX);
      const id = v7.generate();
      this.#rows(
        `INSERT INTO runners (workspaceId, id, name, architecture, tokenHash, createdAt, revokedAt)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        enrollment.workspaceId,
        id,
        input.name.trim(),
        input.architecture,
        await hashRunnerSecret(token),
        new Date().toISOString(),
      );
      return { runnerId: id, runnerToken: token };
    });
  }

  authenticateRunner(token: string): ReturnType<WorkspaceApi["authenticateRunner"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("authenticateRunner", [token]);
      const hash = await hashRunnerSecret(token);
      return this.#rows<{ id: string; workspaceId: WorkspaceId }>(
        "SELECT id, workspaceId FROM runners WHERE tokenHash = ? AND revokedAt IS NULL",
        hash,
      )[0] ?? null;
    });
  }

  listRunners(workspaceId: WorkspaceId): ReturnType<WorkspaceApi["listRunners"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("listRunners", [workspaceId]);
      return this.#rows<Omit<RunnerRow, "workspaceId" | "tokenHash">>(
        `
        SELECT id, name, architecture, createdAt, revokedAt FROM runners
        WHERE workspaceId = ? ORDER BY createdAt DESC
      `,
        workspaceId,
      );
    });
  }

  revokeRunner(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceApi["revokeRunner"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("revokeRunner", [workspaceId, id]);
      return this.#rows(
          `UPDATE runners SET revokedAt = COALESCE(revokedAt, ?)
        WHERE workspaceId = ? AND id = ? RETURNING id`,
          new Date().toISOString(),
          workspaceId,
          id,
        ).length
        ? "revoked"
        : "not-found";
    });
  }

  deleteRunner(workspaceId: WorkspaceId, id: string): ReturnType<WorkspaceApi["deleteRunner"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("deleteRunner", [workspaceId, id]);
      const runner = this.#rows<Pick<RunnerRow, "revokedAt">>(
        "SELECT revokedAt FROM runners WHERE workspaceId = ? AND id = ?",
        workspaceId,
        id,
      )[0];
      if (!runner) return "not-found";
      if (runner.revokedAt === null) return "not-revoked";
      this.#rows("DELETE FROM runners WHERE workspaceId = ? AND id = ?", workspaceId, id);
      return "deleted";
    });
  }

  listSessionNavigationEntries(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceApi["listSessionNavigationEntries"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("listSessionNavigationEntries", [workspaceId]);
      return this.#rows<Awaited<ReturnType<WorkspaceApi["listSessionNavigationEntries"]>>[number]>(
        `
        SELECT s.id, s.projectId, p.name AS projectName, s.initialPromptPreview
        FROM sessions s JOIN projects p ON p.workspaceId = s.workspaceId AND p.id = s.projectId
        WHERE s.workspaceId = ? ORDER BY s.createdAt DESC
      `,
        workspaceId,
      );
    });
  }

  getSessionCatalogEntry(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceApi["getSessionCatalogEntry"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getSessionCatalogEntry", [workspaceId, id]);
      return this.#rows<SessionCatalogEntry>(
        `
        SELECT id, projectId, createdAt, initialPromptPreview FROM sessions WHERE workspaceId = ? AND id = ?
      `,
        workspaceId,
        id,
      )[0] ?? null;
    });
  }

  deleteSessionCatalogEntry(
    workspaceId: WorkspaceId,
    id: string,
    deletedAt: string,
  ): ReturnType<WorkspaceApi["deleteSessionCatalogEntry"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("deleteSessionCatalogEntry", [workspaceId, id, deletedAt]);
      return this.#storage.transactionSync(() => {
        if (
          !this.#rows(
            "DELETE FROM sessions WHERE workspaceId = ? AND id = ? RETURNING id",
            workspaceId,
            id,
          ).length
        ) return ok("not-found");
        this.#rows(
          "INSERT INTO deleted_sessions (workspaceId, sessionId, deletedAt) VALUES (?, ?, ?)",
          workspaceId,
          id,
          deletedAt,
        );
        return ok("deleted");
      });
    });
  }

  reconcileSessionManifestEntries(
    workspaceId: WorkspaceId,
    entries: readonly SessionCatalogEntry[],
  ): ReturnType<WorkspaceApi["reconcileSessionManifestEntries"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("reconcileSessionManifestEntries", [workspaceId, entries]);
      const result: ReconciledSessionManifest = {
        acceptedSessionIds: [],
        tombstonedSessionIds: [],
        rejected: [],
      };
      const pending = new Map<string, SessionCatalogEntry>();
      for (const entry of entries) {
        if (
          this.#rows(
            "SELECT sessionId FROM deleted_sessions WHERE workspaceId = ? AND sessionId = ?",
            workspaceId,
            entry.id,
          ).length
        ) {
          result.tombstonedSessionIds.push(entry.id);
          continue;
        }
        const existing = this.#rows<SessionCatalogEntry>(
          `
          SELECT id, projectId, createdAt, initialPromptPreview FROM sessions WHERE workspaceId = ? AND id = ?
        `,
          workspaceId,
          entry.id,
        )[0] ?? pending.get(entry.id);
        if (
          existing &&
          (existing.projectId !== entry.projectId || existing.createdAt !== entry.createdAt ||
            existing.initialPromptPreview !== entry.initialPromptPreview)
        ) {
          result.rejected.push({ sessionId: entry.id, reason: "catalog-conflict" });
        } else if (
          !this.#rows(
            "SELECT id FROM projects WHERE workspaceId = ? AND id = ?",
            workspaceId,
            entry.projectId,
          ).length
        ) {
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
      this.#storage.transactionSync(() => {
        for (const entry of pending.values()) {
          this.#rows(
            `INSERT INTO sessions (workspaceId, id, projectId, createdAt, initialPromptPreview)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspaceId, id) DO NOTHING`,
            workspaceId,
            entry.id,
            entry.projectId,
            entry.createdAt,
            entry.initialPromptPreview,
          );
        }
      });
      return ok(result);
    });
  }

  startProviderLogin(workspaceId: WorkspaceId): ReturnType<WorkspaceApi["startProviderLogin"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("startProviderLogin", [workspaceId]);
      this.#requireWorkspace(workspaceId);
      const login = await startDeviceLogin();
      await this.#storage.transaction(async (storage) => {
        this.#writeLogin(workspaceId, { status: "pending", login });
        await storage.setAlarm(login.nextPollAt);
      });
      return loginPublic(login);
    });
  }

  getProviderLoginStatus(
    workspaceId: WorkspaceId,
    id: string,
  ): ReturnType<WorkspaceApi["getProviderLoginStatus"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("getProviderLoginStatus", [workspaceId, id]);
      this.#requireWorkspace(workspaceId);
      const state = this.#login();
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
  ): ReturnType<WorkspaceApi["cancelProviderLogin"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("cancelProviderLogin", [workspaceId, id]);
      this.#requireWorkspace(workspaceId);
      const state = this.#login();
      if (state && (state.status === "pending" ? state.login.id : state.id) === id) {
        await this.#clearLogin(workspaceId);
      }
      return;
    });
  }

  disconnectProvider(workspaceId: WorkspaceId): ReturnType<WorkspaceApi["disconnectProvider"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("disconnectProvider", [workspaceId]);
      this.#requireWorkspace(workspaceId);
      await this.#clearLogin(workspaceId);
      const provider = this.#provider(workspaceId, "openai-codex");
      if (!provider) return { status: "not-found" };
      if (provider.credentialType === "oauth") {
        // SAFETY: only validated provider responses create this encrypted OAuth record.
        const credential = JSON.parse(await this.#decrypt(provider.secret)) as OAuthCredential;
        await revokeOAuthCredential(credential).catch(() => {});
      }
      this.#rows(
        "DELETE FROM encrypted_secrets WHERE workspaceId = ? AND key = ?",
        workspaceId,
        provider.secret.key,
      );
      return { status: "deleted" };
    });
  }

  resolveProviderAccessToken(
    workspaceId: WorkspaceId,
  ): ReturnType<WorkspaceApi["resolveProviderAccessToken"]> {
    return this.#serialize(async () => {
      decodeWorkspaceArguments("resolveProviderAccessToken", [workspaceId]);
      this.#requireWorkspace(workspaceId);
      const provider = this.#provider(workspaceId, "openai-codex");
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

  readBrowserSession(id: string): ReturnType<WorkspaceApi["readBrowserSession"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("readBrowserSession", [id]);
      const row = this.#rows<Omit<BrowserSessionRow, "id">>(
        "SELECT data, userId, workspaceId, expiresAt FROM browser_sessions WHERE id = ?",
        id,
      )[0];
      const session = row && browserSessionFromRow(row);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) {
        this.#rows("DELETE FROM browser_sessions WHERE id = ?", id);
        return null;
      }
      return session;
    });
  }

  saveBrowserSession(input: SaveBrowserSession): ReturnType<WorkspaceApi["saveBrowserSession"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("saveBrowserSession", [input]);
      return this.#saveBrowserSession(input);
    });
  }

  deleteBrowserSessions(ids: string[]): ReturnType<WorkspaceApi["deleteBrowserSessions"]> {
    return this.#serialize(() => {
      decodeWorkspaceArguments("deleteBrowserSessions", [ids]);
      this.#storage.transactionSync(() => {
        for (const sessionId of ids) {
          this.#rows("DELETE FROM browser_sessions WHERE id = ?", sessionId);
        }
      });
      return;
    });
  }

  #saveBrowserSession(input: SaveBrowserSession): boolean {
    const values = input.data[0];
    const identity = "auth" in values ? parseBrowserSessionAuth(values.auth) : undefined;
    if ("auth" in values && !identity) throw new Error("Invalid session identity");
    if (identity) {
      const administrator = this.#administrator();
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
    return this.#storage.transactionSync(() => {
      this.#rows("DELETE FROM browser_sessions WHERE expiresAt <= ?", Date.now());
      if (input.mode === "update" || input.mode === "rotate") {
        const previousId = input.mode === "rotate" ? input.previousId : input.id;
        const previous =
          this.#rows<Pick<BrowserSessionRow, "userId" | "workspaceId" | "expiresAt">>(
            "SELECT userId, workspaceId, expiresAt FROM browser_sessions WHERE id = ?",
            previousId,
          )[0];
        if (!previous || previous.expiresAt <= Date.now()) return false;
        if (
          input.mode === "update" &&
          (previous.userId !== record.userId || previous.workspaceId !== record.workspaceId)
        ) return false;
        if (input.mode === "rotate") {
          this.#rows("DELETE FROM browser_sessions WHERE id = ?", previousId);
        }
      }
      if (input.mode === "update") {
        this.#rows(
          "UPDATE browser_sessions SET data = ?, expiresAt = ? WHERE id = ?",
          JSON.stringify(record.data),
          record.expiresAt,
          input.id,
        );
      } else {
        this.#rows(
          "INSERT INTO browser_sessions (id, data, userId, workspaceId, expiresAt) VALUES (?, ?, ?, ?, ?)",
          input.id,
          JSON.stringify(record.data),
          record.userId,
          record.workspaceId,
          record.expiresAt,
        );
      }
      return true;
    });
  }
}

function secretFromRow(row: SecretRow): Secret {
  return {
    key: row.key,
    workspaceId: WorkspaceIdSchema.make(row.workspaceId),
    keyVersion: row.keyVersion,
    ciphertext: new Uint8Array(row.ciphertext),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // SAFETY: Allowed hosts are validated before persistence.
    ...(row.allowedHosts === null
      ? {}
      : { allowedHosts: JSON.parse(row.allowedHosts) as string[] }),
  };
}

function providerFromRow(row: ProviderRow): Provider {
  return {
    id: row.id,
    providerId: row.providerId,
    credentialType: row.credentialType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    secret: secretFromRow(row),
  };
}

function browserSessionFromRow(row: Omit<BrowserSessionRow, "id">): BrowserSessionRecord {
  // SAFETY: The browser session dictionary is validated before persistence.
  return {
    ...row,
    workspaceId: row.workspaceId === null ? null : WorkspaceIdSchema.make(row.workspaceId),
    data: JSON.parse(row.data) as BrowserSessionRecord["data"],
  };
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
