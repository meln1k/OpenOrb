import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { modelReference } from "@openorb/protocol";

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
  .filter((provider) => provider.auth.apiKey !== undefined)
  .sort((left, right) => left.name.localeCompare(right.name));

export const MODEL_PROVIDER_OPTIONS: readonly ModelProviderOption[] = MODEL_PROVIDERS
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
  return MODEL_PROVIDER_OPTIONS.find((provider) => provider.id === providerId)?.name ?? providerId;
}
