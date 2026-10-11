import type { CredentialStore } from "@earendil-works/pi-ai";
import type { WorkspaceId } from "@openorb/protocol/runner-api";
import type { WorkspaceApi } from "../workspace/api.ts";

/** pi-ai refreshes OAuth credentials within five minutes of expiry; stay just outside that window. */
const ACCESS_TOKEN_VALIDITY_MS = 6 * 60_000;
/** Reuse a resolved credential briefly so a burst of model requests is one Workspace call. */
const CACHE_MS = 30_000;

type WorkspaceCredentials = Pick<
  WorkspaceApi,
  "getModelProviderApiKey" | "resolveProviderAccessToken"
>;

/**
 * Model credentials read from the Workspace Durable Object at each resolution. They live only in
 * this isolate's memory and never reach a runner. The Workspace refreshes OpenAI Codex OAuth
 * tokens; pi-ai never sees a refresh token, so it never refreshes on its own.
 */
export class WorkspaceCredentialStore implements CredentialStore {
  readonly #workspace: WorkspaceCredentials;
  readonly #workspaceId: WorkspaceId;
  readonly #cache = new Map<string, { at: number; credential: Credential | undefined }>();

  constructor(workspace: WorkspaceCredentials, workspaceId: WorkspaceId) {
    this.#workspace = workspace;
    this.#workspaceId = workspaceId;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const cached = this.#cache.get(providerId);
    if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.credential;
    const credential = await this.#resolve(providerId);
    this.#cache.set(providerId, { at: Date.now(), credential });
    return credential;
  }

  list() {
    return Promise.resolve([]);
  }

  /** Credentials are owned by the Workspace; pi-ai's refresh path must not rewrite them here. */
  async modify(providerId: string): Promise<Credential | undefined> {
    this.#cache.delete(providerId);
    return await this.read(providerId);
  }

  delete(providerId: string): Promise<void> {
    this.#cache.delete(providerId);
    return Promise.resolve();
  }

  async #resolve(providerId: string): Promise<Credential | undefined> {
    if (providerId === "openai-codex") {
      const access = await this.#workspace.resolveProviderAccessToken(this.#workspaceId);
      return access === null
        ? undefined
        : { type: "oauth", access, refresh: "", expires: Date.now() + ACCESS_TOKEN_VALIDITY_MS };
    }
    const [key, error] = await this.#workspace.getModelProviderApiKey(
      this.#workspaceId,
      providerId,
    );
    if (error !== undefined) throw error;
    return key === null ? undefined : { type: "api_key", key };
  }
}

type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
