import { parseModelReference } from "@openorb/protocol";
import { err, ok, type Result, tryAsync } from "@openorb/result";
import type { SessionModelRuntime, WorkspaceId } from "@openorb/protocol/runner-api";

import type { WorkspaceApi } from "@/app/cells/workspace/api.ts";
import { OPENAI_CODEX_PROVIDER_ID, sessionModelRuntime } from "@/app/model-provider-catalog.ts";

export class ModelProviderRuntimeError extends Error {
  constructor(override readonly cause?: unknown) {
    super("The saved model provider credential could not be resolved.", { cause });
    this.name = "ModelProviderRuntimeError";
  }
}

export async function resolveSessionModelRuntime(
  workspaceId: WorkspaceId,
  model: string,
  workspace: WorkspaceApi,
): Promise<Result<SessionModelRuntime | null, ModelProviderRuntimeError>> {
  const { providerId } = parseModelReference(model);
  if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
    const [apiKey, readError] = await workspace.getModelProviderApiKey(
      workspaceId,
      providerId,
    );
    if (readError !== undefined) return err(new ModelProviderRuntimeError(readError));
    return ok(
      apiKey === null ? null : sessionModelRuntime(model, { type: "api_key", value: apiKey }),
    );
  }

  const [accessToken, resolveError] = await tryAsync(
    workspace.resolveProviderAccessToken(workspaceId),
    (cause) => new ModelProviderRuntimeError(cause),
  );
  if (resolveError !== undefined) return err(resolveError);
  return ok(
    accessToken === null
      ? null
      : sessionModelRuntime(model, { type: "access_token", value: accessToken }),
  );
}
