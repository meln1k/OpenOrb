import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { modelReference } from "@openorb/protocol";
import type { ModelOption, ModelProviderOption } from "./app/model-provider-catalog.ts";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

const MODEL_PROVIDERS = builtinProviders()
  .filter((provider) =>
    provider.auth.apiKey !== undefined || provider.id === OPENAI_CODEX_PROVIDER_ID
  )
  .sort((left, right) => left.name.localeCompare(right.name));

const API_KEY_MODEL_PROVIDERS = MODEL_PROVIDERS
  .filter((provider) => provider.auth.apiKey !== undefined)
  .sort((left, right) => left.name.localeCompare(right.name));

export const MODEL_PROVIDER_OPTIONS: readonly ModelProviderOption[] = API_KEY_MODEL_PROVIDERS
  .map((provider) => ({ id: provider.id, name: provider.name }))
  .sort((left, right) => left.name.localeCompare(right.name));

export const MODEL_OPTIONS: readonly ModelOption[] = MODEL_PROVIDERS.flatMap((provider) =>
  provider.getModels()
    .map((model) => ({
      contextWindow: model.contextWindow,
      id: modelReference(provider.id, model.id),
      name: model.name,
      providerId: provider.id,
      providerName: provider.name,
      thinkingLevels: getSupportedThinkingLevels(model),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
);

if (import.meta.main) {
  await Deno.mkdir("dist", { recursive: true });
  await Deno.writeTextFile(
    "dist/model-catalog.json",
    JSON.stringify({
      providers: MODEL_PROVIDER_OPTIONS,
      models: MODEL_OPTIONS,
      names: MODEL_PROVIDERS.map(({ id, name }) => ({ id, name })),
    }),
  );
}
