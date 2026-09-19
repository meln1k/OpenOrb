import { parseModelReference } from "@openorb/protocol";
import { err, ok, type Result, tryAsync } from "@openorb/result";
import type { SessionModelRuntime, WorkspaceId } from "@openorb/protocol/runner-api";

import type { ModelProviderRepository } from "@/app/data/model-provider-repository.ts";
import { OPENAI_CODEX_PROVIDER_ID, sessionModelRuntime } from "@/app/model-provider-catalog.ts";
import type { OpenAICodexAuthorizationService } from "@/app/openai-codex-authorization.ts";

export class ModelProviderRuntimeError extends Error {
  constructor(override readonly cause?: unknown) {
    super("The saved model provider credential could not be resolved.", { cause });
    this.name = "ModelProviderRuntimeError";
  }
}

export async function resolveSessionModelRuntime(
  workspaceId: WorkspaceId,
  model: string,
  store: ModelProviderRepository,
  openAICodexAuthorization: OpenAICodexAuthorizationService,
  now: () => number = Date.now,
): Promise<Result<SessionModelRuntime | null, ModelProviderRuntimeError>> {
  const { providerId } = parseModelReference(model);
  if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
    const [apiKey, readError] = await store.getModelProviderApiKey(workspaceId, providerId);
    if (readError !== undefined) return err(new ModelProviderRuntimeError(readError));
    return ok(
      apiKey === null ? null : sessionModelRuntime(model, { type: "api_key", value: apiKey }),
    );
  }

  const [accessToken, resolveError] = await tryAsync(
    openAICodexAuthorization.resolveAccessToken(workspaceId, now()),
    (cause) => new ModelProviderRuntimeError(cause),
  );
  if (resolveError !== undefined) return err(resolveError);
  return ok(
    accessToken === null
      ? null
      : sessionModelRuntime(model, { type: "access_token", value: accessToken }),
  );
}
