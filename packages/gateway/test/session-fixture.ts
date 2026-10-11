import { createModels, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Session } from "../app/cells/session/session.ts";

/** A 1×1 PNG the scripted model publishes as Session media. */
export const SCRIPTED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Runs in the checkout: proves the clone and session branch, writes a change for the Git
 * Snapshot, and creates media to publish.
 */
export const SCRIPTED_GUEST_COMMAND = [
  "git rev-parse --abbrev-ref HEAD",
  "uname -s",
  'printf "guest=%s\\n" "$OPENORB_GUEST"',
  "echo e2e > e2e.txt",
  "mkdir -p .openorb/artifacts",
  `printf '%s' '${SCRIPTED_PNG_BASE64}' | base64 -d > .openorb/artifacts/dot.png`,
  "echo e2e-done",
].join(" && ");

/**
 * A Session whose model is pi-ai's scripted faux provider: a bash call in the guest, a
 * publish_media call, then an answer. Disposable fixture only; production Sessions use Workspace
 * credentials.
 */
export class ScriptedSession extends Session {
  protected override agentModels(_credentials: CredentialStore): Models {
    const faux = fauxProvider({ models: [{ id: "demo" }], tokensPerSecond: 1_000_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: SCRIPTED_GUEST_COMMAND }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("publish_media", { path: ".openorb/artifacts/dot.png", description: "dot" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("The guest answered."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }
}
