import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_SESSION_THINKING_LEVEL, modelReference } from "@openorb/protocol";
import { SessionModelRuntime } from "@openorb/protocol/runner-api";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export interface ModelProviderOption {
  id: string;
  name: string;
}

export interface ModelOption {
  contextWindow: number;
  id: string;
  name: string;
  providerId: string;
  providerName: string;
}

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
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
);

const MODEL_PROVIDER_IDS = new Set(MODEL_PROVIDER_OPTIONS.map((provider) => provider.id));
const MODEL_IDS = new Set(MODEL_OPTIONS.map((model) => model.id));

export function isModelProviderId(value: string): boolean {
  return MODEL_PROVIDER_IDS.has(value);
}

export function isModelReference(value: string): boolean {
  return MODEL_IDS.has(value);
}

export function modelContextWindow(value: string): number | undefined {
  return MODEL_OPTIONS.find((model) => model.id === value)?.contextWindow;
}

export function modelProviderName(providerId: string): string {
  return MODEL_PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId;
}

export function sessionModelRuntime(
  model: string,
  credential: SessionModelRuntime["credential"],
): SessionModelRuntime {
  return new SessionModelRuntime({
    model,
    thinkingLevel: DEFAULT_SESSION_THINKING_LEVEL,
    credential,
  });
}
