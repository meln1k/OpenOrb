import { clampThinkingLevel, InMemoryCredentialStore, type Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { parseModelReference } from "@openorb/protocol";
import type { SessionModelRuntime, ThinkingLevel } from "@openorb/protocol/runner-api";
import { AgentHarnessError } from "../agent-harness.ts";

/** Per-open credentials; neither ambient auth nor host resource discovery is permitted. */
export async function createDurableModels(runtime: SessionModelRuntime) {
  const credentials = new InMemoryCredentialStore();
  const models = builtinModels({
    credentials,
    authContext: {
      env: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    },
  });
  const update = async (next: SessionModelRuntime) => {
    const { providerId, modelId } = parseModelReference(next.model);
    if (!models.getModel(providerId, modelId)) {
      throw new AgentHarnessError("Configured model is unavailable", undefined);
    }
    await credentials.modify(providerId, () =>
      Promise.resolve(
        next.credential.type === "api_key" ? { type: "api_key", key: next.credential.value } : {
          type: "oauth",
          access: next.credential.value,
          refresh: "",
          expires: Number.MAX_SAFE_INTEGER,
        },
      ));
  };
  await update(runtime);
  return { models, update };
}

export function durableModelRef(runtime: SessionModelRuntime) {
  const { providerId, modelId } = parseModelReference(runtime.model);
  return { provider: providerId, modelId };
}

export function thinkingLevel(
  models: Models,
  runtime: SessionModelRuntime,
  requested: ThinkingLevel,
): ThinkingLevel {
  const ref = durableModelRef(runtime);
  const model = models.getModel(ref.provider, ref.modelId);
  if (model === undefined) {
    throw new AgentHarnessError("Configured model is unavailable", undefined);
  }
  return clampThinkingLevel(model, requested);
}
