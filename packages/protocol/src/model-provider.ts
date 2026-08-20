import { parse, parseSafe, string } from "@remix-run/data-schema";

export const DEFAULT_SESSION_MODEL = "opencode-go/deepseek-v4-flash";
export const DEFAULT_SESSION_THINKING_LEVEL = "high";

export const modelProviderIdSchema = string().refine(
  (value) =>
    value.length > 0 &&
    value.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value),
  "Expected a valid model provider identifier.",
);

export const modelReferenceSchema = string().refine(
  (value) => {
    const separator = value.indexOf("/");
    return separator > 0 &&
      separator < value.length - 1 &&
      value.length <= 512 &&
      parseSafe(modelProviderIdSchema, value.slice(0, separator)).success &&
      !/\s/u.test(value.slice(separator + 1));
  },
  "Expected a provider/model reference.",
);

export interface ParsedModelReference {
  providerId: string;
  modelId: string;
}

export function parseModelReference(value: string): ParsedModelReference {
  const reference = parse(modelReferenceSchema, value);
  const separator = reference.indexOf("/");
  return {
    providerId: reference.slice(0, separator),
    modelId: reference.slice(separator + 1),
  };
}

export function modelReference(providerId: string, modelId: string): string {
  return parse(modelReferenceSchema, `${providerId}/${modelId}`);
}
