import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { SessionId } from "@openorb/protocol/runner-api";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import {
  type AgentEnvironment,
  AgentEnvironmentError,
} from "../../../src/environment/agent-environment.ts";
import type { AgentHarnessOpenOptions } from "../../../src/harness/agent-harness.ts";
import { makeDurableAgentHarness } from "../../../src/harness/durable/layer.ts";
import { SessionArtifact, SessionArtifactId } from "@openorb/protocol/runner-bulk-api";
import type { SessionArtifactStore } from "../../../src/session/artifact-store.ts";

export function memoryGuest() {
  const files = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const environment: AgentEnvironment = {
    run: (command) =>
      Effect.suspend(() =>
        command[0] === "/usr/bin/test" && command[1] === "-e"
          ? Effect.succeed({ exitCode: files.has(command[2]!) ? 0 : 1 })
          : Effect.die("Unexpected guest command")
      ),
    runShell: (_command, options) =>
      options.onOutput(new TextEncoder().encode("guest output"), "stdout").pipe(
        Effect.as({ exitCode: 0 }),
        Effect.mapError((cause) => new AgentEnvironmentError("output", cause)),
      ),
    readFile: (path, options) =>
      Effect.suspend(() => {
        reads.push(path);
        const bytes = files.get(path);
        if (!bytes) return Effect.fail(new AgentEnvironmentError("missing guest file", undefined));
        if (bytes.length > (options?.maxBytes ?? Infinity)) {
          return Effect.fail(new AgentEnvironmentError("too large", undefined));
        }
        return Effect.succeed(bytes);
      }),
    access: (path) =>
      Effect.suspend(() =>
        files.has(path) ? Effect.void : Effect.fail(new AgentEnvironmentError("missing", undefined))
      ),
    writeFile: (path, content) =>
      Effect.sync(() => {
        files.set(
          path,
          Schema.is(Schema.String)(content) ? new TextEncoder().encode(content) : content,
        );
      }),
    makeDirectory: () => Effect.void,
    stat: (path) =>
      Effect.suspend(() => {
        const bytes = files.get(path);
        const directory = [...files.keys()].some((file) => file.startsWith(`${path}/`));
        return bytes === undefined && !directory
          ? Effect.fail(new AgentEnvironmentError("missing", undefined))
          : Effect.succeed({
            isFile: () => bytes !== undefined,
            isDirectory: () => directory,
            size: bytes?.length ?? 0,
            mtimeMs: 0,
          });
      }),
    listDirectory: (path) =>
      Effect.suspend(() => {
        const names = [...files.keys()].filter((file) => file.startsWith(`${path}/`))
          .map((file) => file.slice(path.length + 1).split("/")[0]!);
        return names.length > 0
          ? Effect.succeed([...new Set(names)])
          : Effect.fail(new AgentEnvironmentError("missing directory", undefined));
      }),
    renameFile: () => Effect.die("unexpected rename"),
    remove: () => Effect.die("unexpected remove"),
    detectImageMimeType: () => Effect.succeed(null),
    stop: Effect.void,
  };
  return { environment, files, reads };
}

export const artifactStore: SessionArtifactStore = {
  publish: (_sessionId, input) =>
    Effect.succeed(
      new SessionArtifact({
        id: Schema.decodeUnknownSync(SessionArtifactId)("01989d78-65ee-7f6a-a97e-0f16ad134c10"),
        fileName: input.fileName,
        mediaType: input.mediaType,
        byteLength: input.bytes.length,
      }),
    ),
  readChunk: () => Effect.die("Not used"),
};

export function optionsFor(
  directory: string,
  guest: AgentEnvironment = memoryGuest().environment,
): AgentHarnessOpenOptions {
  return {
    sessionId: Schema.decodeUnknownSync(SessionId)("01989d78-65ee-7f6a-a97e-0f16ad134c10"),
    state: { directory },
    environment: guest,
    environmentState: "running",
    environmentStates: Stream.make("running"),
    git: { repositoryUrl: "https://github.com/example/project.git", branchName: "openorb/test" },
    modelRuntime: {
      model: "faux/test",
      thinkingLevel: "off",
      credential: { type: "api_key", value: "private-test-credential" },
    },
    controlEnvironment: (action) =>
      Effect.succeed({ state: action === "stop" ? "stopped" : "running", forced: false }),
  };
}

export function fixtureHarness(provider = "faux") {
  const faux = fauxProvider({
    provider,
    models: [{ id: "test", reasoning: true, input: ["text", "image"] }],
    tokensPerSecond: 100000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = makeDurableAgentHarness(
    artifactStore,
    () => Promise.resolve({ models, update: () => Promise.resolve() }),
  );
  return {
    faux,
    async open(options: AgentHarnessOpenOptions) {
      const scope = Scope.makeUnsafe();
      try {
        const session = await Effect.runPromise(
          harness.open(options).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        return { session, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
      } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw cause;
      }
    },
  };
}

export async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for harness state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
