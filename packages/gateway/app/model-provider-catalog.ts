import catalog from "../dist/model-catalog.json" with { type: "json" };
import { DEFAULT_SESSION_THINKING_LEVEL, type SessionThinkingLevel } from "@openorb/protocol";
import type { SessionModelRuntime } from "@openorb/protocol/runner-api";

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
  thinkingLevels: readonly SessionThinkingLevel[];
}
export const MODEL_PROVIDER_OPTIONS: readonly ModelProviderOption[] = catalog.providers;
// SAFETY: build-model-catalog emits the pinned Pi catalog's declared thinking levels.
export const MODEL_OPTIONS: readonly ModelOption[] = catalog.models as ModelOption[];
const MODEL_PROVIDER_IDS = new Set(MODEL_PROVIDER_OPTIONS.map((p) => p.id));
const MODEL_IDS = new Set(MODEL_OPTIONS.map((m) => m.id));
export function isModelProviderId(value: string) {
  return MODEL_PROVIDER_IDS.has(value);
}
export function isModelReference(value: string) {
  return MODEL_IDS.has(value);
}
export function modelContextWindow(value: string) {
  return MODEL_OPTIONS.find((m) => m.id === value)?.contextWindow;
}
export function modelThinkingLevels(value: string) {
  return MODEL_OPTIONS.find((m) => m.id === value)?.thinkingLevels;
}
export function modelProviderName(id: string) {
  return catalog.names.find((p) => p.id === id)?.name ?? id;
}
export function sessionModelRuntime(
  model: string,
  credential: SessionModelRuntime["credential"],
): SessionModelRuntime {
  return {
    model,
    thinkingLevel: DEFAULT_SESSION_THINKING_LEVEL,
    credential,
  };
}
