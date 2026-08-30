import { tryAsync } from "../../../../result/src/index.ts";
import { literal, object, parseSafe, string } from "remix/data-schema";

const actionAcceptedResponseSchema = object(
  { status: literal("accepted" as const) },
  { unknownKeys: "error" },
);
const actionErrorResponseSchema = object(
  { error: string() },
  { unknownKeys: "error" },
);

export async function actionResponseAccepted(response: Response): Promise<boolean> {
  const [body, readError] = await tryAsync(response.json(), () => true);
  if (readError !== undefined) return false;
  return parseSafe(actionAcceptedResponseSchema, body).success;
}

export async function actionResponseError(response: Response, label: string): Promise<string> {
  const fallback = response.status > 0 ? `${label} (${response.status}).` : `${label}.`;
  const [body, readError] = await tryAsync(response.json(), () => true);
  if (readError !== undefined) return fallback;
  const parsed = parseSafe(actionErrorResponseSchema, body);
  return parsed.success && parsed.value.error.trim() ? parsed.value.error : fallback;
}
