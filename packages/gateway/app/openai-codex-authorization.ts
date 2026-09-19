import type { AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { WorkspaceId } from "@openorb/protocol/runner-api";
import { tryAsync } from "@openorb/result";

import type {
  DeleteModelProviderCredentialResult,
  ModelProviderOAuthCredential,
  ModelProviderRepository,
} from "@/app/data/model-provider-repository.ts";
import { OPENAI_CODEX_PROVIDER_ID } from "@/app/model-provider-catalog.ts";

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_REVOKE_URL = "https://auth.openai.com/oauth/revoke";
const TOKEN_OPERATION_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 10_000;

export interface OpenAICodexAuthorization {
  readonly id: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
}

export type OpenAICodexAuthorizationStatus =
  | { readonly status: "pending"; readonly authorization: OpenAICodexAuthorization }
  | { readonly status: "complete" }
  | { readonly status: "error" }
  | { readonly status: "missing" };

export interface OpenAICodexAuthorizationService {
  start(workspaceId: WorkspaceId): Promise<OpenAICodexAuthorization>;
  status(workspaceId: WorkspaceId, attemptId: string): OpenAICodexAuthorizationStatus;
  cancel(workspaceId: WorkspaceId, attemptId: string): Promise<void>;
  disconnect(workspaceId: WorkspaceId): Promise<DeleteModelProviderCredentialResult>;
  resolveAccessToken(workspaceId: WorkspaceId, now?: number): Promise<string | null>;
}

export interface OpenAICodexAuthorizationOptions {
  readonly oauth?: OAuthAuth;
  readonly revoke?: (credential: OAuthCredential) => Promise<void>;
}

export class OpenAICodexAuthorizationError extends Error {
  override readonly name = "OpenAICodexAuthorizationError";
}

interface AuthorizationAttempt {
  readonly id: string;
  readonly controller: AbortController;
  readonly ready: Promise<OpenAICodexAuthorization>;
  readonly resolveReady: (authorization: OpenAICodexAuthorization) => void;
  readonly rejectReady: (error: Error) => void;
  authorization?: OpenAICodexAuthorization;
  status: "starting" | "pending" | "complete" | "error";
}

const REFRESH_LEEWAY_MS = 5 * 60 * 1_000;

export function createOpenAICodexAuthorizationService(
  store: ModelProviderRepository,
  options: OpenAICodexAuthorizationOptions = {},
): OpenAICodexAuthorizationService {
  const oauth = options.oauth ?? openAICodexOAuth();
  const revoke = options.revoke ?? revokeOpenAICodexCredential;
  const attempts = new Map<WorkspaceId, AuthorizationAttempt>();
  const modificationChains = new Map<WorkspaceId, Promise<unknown>>();

  const enqueue = <T>(
    workspaceId: WorkspaceId,
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    const previous = modificationChains.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.catch(() => {});
    modificationChains.set(workspaceId, tail);
    void tail.then(() => {
      if (modificationChains.get(workspaceId) === tail) modificationChains.delete(workspaceId);
    });
    return current;
  };

  const invalidateAttempt = (workspaceId: WorkspaceId): void => {
    const current = attempts.get(workspaceId);
    if (!current) return;
    attempts.delete(workspaceId);
    current.controller.abort();
    current.rejectReady(
      new OpenAICodexAuthorizationError("The ChatGPT sign-in is no longer active."),
    );
  };

  const failAttempt = (
    workspaceId: WorkspaceId,
    attempt: AuthorizationAttempt,
  ): void => {
    if (attempts.get(workspaceId) !== attempt) return;
    attempt.status = "error";
    attempt.rejectReady(
      new OpenAICodexAuthorizationError("ChatGPT sign-in could not be completed."),
    );
  };

  const runAttempt = async (
    workspaceId: WorkspaceId,
    attempt: AuthorizationAttempt,
  ): Promise<void> => {
    const [credential, loginError] = await tryAsync(
      oauth.login({
        signal: attempt.controller.signal,
        prompt: (prompt) => selectDeviceCode(prompt),
        notify(event) {
          if (
            event.type !== "device_code" ||
            attempt.controller.signal.aborted ||
            attempts.get(workspaceId) !== attempt
          ) return;
          const authorization = {
            id: attempt.id,
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: Math.max(1, event.intervalSeconds ?? 5),
          };
          attempt.authorization = authorization;
          attempt.status = "pending";
          attempt.resolveReady(authorization);
        },
      }),
      () => true,
    );
    if (loginError !== undefined) {
      failAttempt(workspaceId, attempt);
      return;
    }
    const [, saveError] = await tryAsync(
      enqueue(workspaceId, async () => {
        if (
          attempts.get(workspaceId) !== attempt ||
          attempt.controller.signal.aborted
        ) return;
        if (!attempt.authorization) {
          attempt.status = "error";
          attempt.rejectReady(
            new OpenAICodexAuthorizationError(
              "ChatGPT sign-in did not provide a device code.",
            ),
          );
          return;
        }
        await store.saveModelProviderOAuthCredential(
          workspaceId,
          OPENAI_CODEX_PROVIDER_ID,
          normalizeCredential(credential),
        );
        attempt.status = "complete";
      }),
      () => true,
    );
    if (saveError !== undefined) {
      failAttempt(workspaceId, attempt);
      return;
    }
  };

  return {
    async start(workspaceId) {
      const attempt = await enqueue(workspaceId, () => {
        invalidateAttempt(workspaceId);
        const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise
          .withResolvers<OpenAICodexAuthorization>();
        const next: AuthorizationAttempt = {
          id: crypto.randomUUID(),
          controller: new AbortController(),
          ready,
          resolveReady,
          rejectReady,
          status: "starting",
        };
        attempts.set(workspaceId, next);
        void runAttempt(workspaceId, next);
        return next;
      });
      return await attempt.ready;
    },

    status(workspaceId, attemptId) {
      const attempt = attempts.get(workspaceId);
      if (!attempt || attempt.id !== attemptId) return { status: "missing" };
      if (attempt.status === "pending" && attempt.authorization) {
        return { status: "pending", authorization: attempt.authorization };
      }
      if (attempt.status === "complete" || attempt.status === "error") {
        attempts.delete(workspaceId);
        return { status: attempt.status };
      }
      return { status: "missing" };
    },

    cancel(workspaceId, attemptId) {
      return enqueue(workspaceId, () => {
        if (attempts.get(workspaceId)?.id === attemptId) invalidateAttempt(workspaceId);
      });
    },

    disconnect(workspaceId) {
      return enqueue(workspaceId, async () => {
        invalidateAttempt(workspaceId);
        return await store.deleteModelProviderOAuthCredential(
          workspaceId,
          OPENAI_CODEX_PROVIDER_ID,
          (credential) => revoke(normalizeCredential(credential)),
        );
      });
    },

    async resolveAccessToken(workspaceId, now = Date.now()) {
      const [credential, readError] = await store.modifyModelProviderOAuthCredential(
        workspaceId,
        OPENAI_CODEX_PROVIDER_ID,
        (current) =>
          current.expires <= now + REFRESH_LEEWAY_MS
            ? oauth.refresh(
              normalizeCredential(current),
              AbortSignal.timeout(TOKEN_OPERATION_TIMEOUT_MS),
            ).then(
              normalizeCredential,
            )
            : Promise.resolve(current),
      );
      if (readError !== undefined) throw readError;
      if (credential === null) return null;
      const auth = await oauth.toAuth(normalizeCredential(credential));
      if (!auth.apiKey) {
        throw new OpenAICodexAuthorizationError(
          "OpenAI Codex OAuth did not provide an access token.",
        );
      }
      return auth.apiKey;
    },
  };
}

function selectDeviceCode(prompt: AuthPrompt): Promise<string> {
  if (
    prompt.type === "select" &&
    prompt.options.some((option) => option.id === "device_code")
  ) return Promise.resolve("device_code");
  return Promise.reject(
    new OpenAICodexAuthorizationError(
      "OpenAI Codex requested an unsupported login interaction.",
    ),
  );
}

function openAICodexOAuth(): OAuthAuth {
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) {
    throw new OpenAICodexAuthorizationError("OpenAI Codex OAuth is unavailable.");
  }
  return oauth;
}

function normalizeCredential(
  credential: OAuthCredential | ModelProviderOAuthCredential,
): OAuthCredential & ModelProviderOAuthCredential {
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
  };
}

async function revokeOpenAICodexCredential(credential: OAuthCredential): Promise<void> {
  const response = await fetch(OPENAI_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: credential.refresh,
      token_type_hint: "refresh_token",
      client_id: OPENAI_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OpenAICodexAuthorizationError(
      `OpenAI Codex credential revocation failed with status ${response.status}.`,
    );
  }
}
