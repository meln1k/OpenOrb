import { createModels, type CredentialStore, type Models } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Session, type SessionContext } from "../app/cells/session/session.ts";
import { type EnvironmentStatus, sandboxProvider } from "@openorb/environments";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SessionId, WorkspaceId } from "@openorb/protocol/runner-api";

/** A 1×1 PNG the scripted model publishes as Session media. */
export const SCRIPTED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Runs in the checkout: proves the clone and session branch, writes a change for the Git
 * Snapshot, creates media to publish, and adds a skill that the fixed catalog must not pick up.
 * Guests without Git or uname, such as the sandbox, report that instead.
 */
export const SCRIPTED_GUEST_COMMAND = [
  "(git rev-parse --abbrev-ref HEAD || echo no-git)",
  "(uname -s || echo no-uname)",
  "cat README.md | head -n 1",
  'printf "guest=%s\\n" "$OPENORB_GUEST"',
  "echo e2e > e2e.txt",
  "mkdir -p .openorb/artifacts .agents/skills/e2e-skill",
  `printf '%s\\n' '---' 'name: e2e-skill' 'description: Proves skill discovery.' '---' > .agents/skills/e2e-skill/SKILL.md`,
  `printf '%s' '${SCRIPTED_PNG_BASE64}' | base64 -d > .openorb/artifacts/dot.png`,
  "echo temporary > /tmp/openorb-idle-marker",
  "echo e2e-done",
].join(" && ");

/**
 * A Session whose model is pi-ai's scripted faux provider: a bash call in the guest, a
 * publish_media call, then an answer; later prompts echo the repository skills it sees. Disposable fixture only; production Sessions use Workspace
 * credentials.
 */
export class ScriptedSession extends Session {
  /** Disposable runtime probe: retained original handles prevent GC from hiding a loader leak. */
  async sandboxReloadProbe(): Promise<{ cycles: number; retained: number }> {
    const retained: ReturnType<WorkerLoader["get"]>[] = [];
    let status: EnvironmentStatus = { state: "stopped", reachable: true };
    const provider = sandboxProvider({
      loader: {
        get: (...args) => {
          const worker = this.env.LOADER.get(...args);
          retained.push(worker);
          return worker;
        },
        load: (code) => this.env.LOADER.load(code),
      },
    });
    const environment = provider.open({
      workspaceId: WorkspaceId.make(crypto.randomUUID()),
      sessionId: SessionId.make(crypto.randomUUID()),
      placement: { provider: "sandbox" },
      // SAFETY: Session's constructor receives this context; the Deno runtime shim types it unknown.
      facets: (this.ctx as SessionContext).facets,
      acceptWebSocket: () => {},
      getWebSockets: () => [],
      status: () => status,
      report: (next) => (status = next),
      reconcile: () => {},
    });
    await environment.control("start");
    for (let cycle = 0; cycle < 260; cycle++) {
      const previous = await environment.env.readTextFile("/workspace/cycle", BACKGROUND_CONTEXT);
      if (cycle > 0 && (!previous.ok || previous.value !== String(cycle - 1))) {
        throw new Error(`Persistent state lost at cycle ${cycle}`);
      }
      const temporary = await environment.env.exists("/tmp/marker", BACKGROUND_CONTEXT);
      if (!temporary.ok || temporary.value) {
        throw new Error(`Idle release failed at cycle ${cycle}`);
      }
      for (const path of ["/workspace/cycle", "/tmp/marker"]) {
        const result = await environment.env.writeFile(path, String(cycle), BACKGROUND_CONTEXT);
        if (!result.ok) throw result.error;
      }
      environment.release();
    }
    await environment.delete();
    return { cycles: 260, retained: retained.length };
  }

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
      // Later prompts report the repository skills section the model was given.
      ...Array.from({ length: 24 }, () => (context: TranscriptContext) => {
        const prompt = context.messages.findLast((message) => message.role === "user");
        const content = prompt?.content ?? "";
        // Pi permits user content as either a string or content blocks.
        const text =
          // oxlint-disable-next-line openorb/no-runtime-typeof
          typeof content === "string"
            ? content
            : content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
        if (text.startsWith("Codemode: ")) {
          return context.messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage(`Codemode finished: ${text}`)
            : fauxAssistantMessage(
                fauxToolCall("codemode", { code: text.slice("Codemode: ".length) }),
                { stopReason: "toolUse" },
              );
        }
        if (JSON.stringify(prompt).includes("Check idle sandbox")) {
          return context.messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage("Idle sandbox checked.")
            : fauxAssistantMessage(
                fauxToolCall("bash", {
                  command:
                    "cat e2e.txt && (test -e /tmp/openorb-idle-marker && echo still-live || echo released)",
                }),
                { stopReason: "toolUse" },
              );
        }
        return fauxAssistantMessage(`Skills: ${repositorySkillsSection(context)}`);
      }),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }
}

/** The last `repository-skills` prompt section in effect for a model request. */
function repositorySkillsSection(context: TranscriptContext): string {
  return (
    context.messages
      .filter((message) => message.role === "system")
      .map((message) => message.sections?.["repository-skills"])
      .findLast((section) => section !== undefined) ?? ""
  );
}
