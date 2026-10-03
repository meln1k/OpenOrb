import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { SessionModelRuntime } from "@openorb/protocol/runner-api";
import { Effect, Layer, Semaphore, Stream } from "effect";
import { SessionArtifactStore } from "../../session/artifact-store.ts";
import {
  AgentHarness,
  AgentHarnessError,
  type AgentHarnessOpenOptions,
  type AgentHarnessSession,
} from "../agent-harness.ts";
import { createGuestExecutionEnv } from "./environment.ts";
import { conversationViews } from "./events.ts";
import { createDurableModels, durableModelRef, thinkingLevel } from "./models.ts";
import { discoverRepositorySkills, repositorySkillsPrompt } from "./skills.ts";
import { openDurableStorage } from "./storage.ts";
import { createDurableTools } from "./tools.ts";

export { readDurableView } from "./storage.ts";

export interface DurableModelAccess {
  readonly models: Models;
  readonly update: (runtime: SessionModelRuntime) => Promise<void>;
}

/** Injection seam for deterministic provider tests, not a second agent implementation. */
export function makeDurableAgentHarness(
  artifacts: SessionArtifactStore,
  createModels: (runtime: SessionModelRuntime) => Promise<DurableModelAccess> = createDurableModels,
): AgentHarness {
  return AgentHarness.of({
    open: (options) =>
      Effect.gen(function* () {
        const modelAccess = yield* attempt(() => createModels(options.modelRuntime));
        const registry = createRegistry();
        registry.install({
          name: "openorb",
          tools: createDurableTools(options, artifacts),
          sections: [{ key: "openorb", render: () => systemPrompt(options) }],
        });
        const env = createGuestExecutionEnv(options.environment, `openorb:${options.sessionId}`);
        const storage = yield* Effect.acquireRelease(
          attempt(() => openDurableStorage(options.state.directory)),
          (storage) => Effect.promise(() => storage.close(BACKGROUND_CONTEXT)),
        );
        const harness = yield* Effect.acquireRelease(
          attempt(() =>
            Harness.open(storage, {
              models: modelAccess.models,
              registry,
              env: () => env,
              settings: {
                stream: {
                  headers: options.modelRuntime.model.startsWith("opencode-go/")
                    ? { "x-opencode-session": options.sessionId }
                    : {},
                },
              },
            }, BACKGROUND_CONTEXT)
          ),
          (harness) => Effect.promise(() => harness.close(BACKGROUND_CONTEXT)),
        );
        const conversation = yield* attempt(() =>
          harness.root(BACKGROUND_CONTEXT, {
            agent: {
              model: durableModelRef(options.modelRuntime),
              thinkingLevel: thinkingLevel(
                modelAccess.models,
                options.modelRuntime,
                options.modelRuntime.thinkingLevel,
              ),
              cwd: "/workspace",
            },
          })
        );
        const state = yield* Effect.acquireRelease(
          attempt(() => conversation.viewState(BACKGROUND_CONTEXT)),
          (state) => Effect.sync(() => state.dispose()),
        );
        const lock = yield* Semaphore.make(1);
        let runtime = options.modelRuntime;

        yield* options.environmentStates.pipe(
          Stream.switchMap((environmentState) =>
            Stream.fromEffect(
              (environmentState === "running"
                ? discoverRepositorySkills(options.environment).pipe(
                  Effect.timeout(10_000),
                  Effect.map(repositorySkillsPrompt),
                  Effect.catch(() =>
                    Effect.logWarning("Repository skill discovery failed or timed out.").pipe(
                      Effect.as("Repository skills could not be loaded."),
                    )
                  ),
                )
                : Effect.succeed(
                  "Repository skills will be discovered when the guest project is ready.",
                ))
                .pipe(Effect.tap((prompt) =>
                  Effect.sync(() => {
                    registry.install({
                      name: "repository-skills",
                      sections: [{
                        key: "repository-skills",
                        render: () =>
                          options.environmentState === "running"
                            ? prompt
                            : "Repository skills will be discovered when the guest project is ready.",
                      }],
                    });
                  })
                )),
            )
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );

        const session: AgentHarnessSession = {
          get view() {
            return state.value;
          },
          views: conversationViews(conversation),
          resume: attempt(() => {
            harness.resume();
            return Promise.resolve();
          }),
          abort: attempt(() => conversation.abort(BACKGROUND_CONTEXT, { background: true })),
          updateModelRuntime: (next) =>
            lock.withPermit(attempt(async () => {
              await modelAccess.update(next);
              await conversation.configure({ model: durableModelRef(next) }, BACKGROUND_CONTEXT);
              runtime = next;
            })),
          setThinkingLevel: (level) =>
            lock.withPermit(attempt(async () => {
              const effective = thinkingLevel(modelAccess.models, runtime, level);
              await conversation.configure({ thinkingLevel: effective }, BACKGROUND_CONTEXT);
              return effective;
            })),
          submit: (input, requestId) =>
            lock.withPermit(
              attempt(async () => {
                if (!requestId.trim()) {
                  throw new AgentHarnessError("A request ID is required", undefined);
                }
                // submit() resumes the entire harness, even for duplicates. A retry must only
                // observe the persisted admission, especially after reopening paused work.
                const existing = await storage.submissionByRequest(
                  conversation.id,
                  requestId,
                  BACKGROUND_CONTEXT,
                );
                if (existing !== undefined) return existing.id;
                return (await conversation.submit({
                  type: "input",
                  content: input,
                  requestId,
                  whenBusy: "followUp",
                }, BACKGROUND_CONTEXT)).id;
              }).pipe(Effect.uninterruptible),
            ),
        };
        return session;
      }),
  });
}

export function durableAgentHarnessLayer(): Layer.Layer<AgentHarness, never, SessionArtifactStore> {
  return Layer.effect(
    AgentHarness,
    Effect.map(SessionArtifactStore, (artifacts) => makeDurableAgentHarness(artifacts)),
  );
}

function attempt<T>(action: () => Promise<T>): Effect.Effect<T, AgentHarnessError> {
  // Provider failures may contain authorization material. Do not expose raw causes through RPC.
  return Effect.tryPromise({
    try: action,
    catch: (cause) =>
      cause instanceof AgentHarnessError ? cause : new AgentHarnessError(
        "Durable harness operation failed; inspect the conversation before retrying.",
        undefined,
      ),
  });
}

export function systemPrompt(options: Pick<AgentHarnessOpenOptions, "git">): string {
  return [
    "You are an expert coding assistant. Use only the tools supplied by OpenOrb.",
    "All shell and file operations run in the isolated guest, never on the trusted runner host. Relative paths resolve from /workspace.",
    "The environment tool controls the guest independently of this conversation. Start it when needed; stopping preserves disk, not RAM or processes. Do not shut down the guest using bash.",
    "Use bash for ls, rg, and find. Every bash command requires a timeout in seconds. Be concise and show file paths clearly.",
    "Use read for text files and readImage to inspect images.",
    "To show media, use publish_media and include its exact returned Markdown.",
    "Create commits or push only when the user explicitly requests it. Preserve existing commits: never amend, squash, reset, rewrite history, or force-push.",
    `Keep all work on session branch ${
      JSON.stringify(options.git.branchName)
    }. Push only that branch to canonical repository ${
      JSON.stringify(options.git.repositoryUrl)
    }, never an agent-modified remote destination.`,
  ].join("\n");
}
