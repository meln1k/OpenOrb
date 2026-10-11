import { createModels, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Session } from "../app/cells/session/session.ts";

/** The guest command the scripted model runs, and the marker its output must contain. */
export const SCRIPTED_GUEST_COMMAND =
  'uname -s; id -un; printf "guest=%s\\n" "$OPENORB_GUEST"; echo e2e > /workspace/e2e.txt && cat /workspace/e2e.txt';

/**
 * A Session whose model is pi-ai's scripted faux provider: one bash call in the guest, then an
 * answer. Disposable fixture only; production Sessions use Workspace credentials.
 */
export class ScriptedSession extends Session {
  protected override agentModels(_credentials: CredentialStore): Models {
    const faux = fauxProvider({ models: [{ id: "demo" }], tokensPerSecond: 1_000_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: SCRIPTED_GUEST_COMMAND }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The guest answered."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }
}
