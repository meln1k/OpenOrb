import { assert, assertEquals } from "@std/assert";
import * as DenoSocket from "@effect/platform-deno/DenoSocket";
import {
  DeleteSessionAccepted,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  RunnerCapacity,
  RunnerIdentity,
  RunnerSessionSnapshot,
  RunnerStateEvent,
  StopSessionAccepted,
} from "@openorb/protocol/runner-api";
import {
  RunnerBulkApi,
  runnerBulkRpcSerializationLayer,
  SessionArtifact,
  SessionArtifactChunk,
  SessionArtifactId,
  SessionGitPatchChunk,
} from "@openorb/protocol/runner-bulk-api";
import { MAX_RUNNER_BULK_CHUNK_BYTES } from "@openorb/protocol/runner-api-limits";
import {
  runnerControlRpcSerializationLayer,
  runnerControlWebSocket,
} from "@openorb/protocol/runner-control-transport";
import { Deferred, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import * as NetAddress from "effect/net/NetAddress";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import { createRpcClient } from "./workspace/rpc-client.ts";

// Only point this at test/celld.jsonc: Workspace.fetch throws and all data is disposable.
const gatewayUrl = Deno.env.get("OPENORB_TEST_GATEWAY_URL");
const decode = Schema.decodeUnknownSync;
const capacity = new RunnerCapacity({
  activeSessions: 1,
  vmCpuCount: 8,
  vmMemoryMiB: 16_384,
  diskFreeMiB: 50_000,
});
const image = Uint8Array.from({ length: MAX_RUNNER_BULK_CHUNK_BYTES + 19 }, (_, i) => i % 256);
const artifact = new SessionArtifact({
  id: SessionArtifactId.make(crypto.randomUUID()),
  fileName: "native-rpc.png",
  mediaType: "image/png",
  byteLength: image.length,
});

function endpoint(path: string, params: Record<string, string> = {}) {
  assert(gatewayUrl);
  const url = new URL(path, gatewayUrl);
  url.search = new URLSearchParams(params).toString();
  return url;
}

async function request(path: string, params: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(endpoint(path, params), {
    signal: AbortSignal.timeout(5_000),
    ...(body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return response;
}

async function json(path: string, params: Record<string, string> = {}, body?: unknown) {
  const response = await request(path, params, body);
  assertEquals(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}

const eventually = (predicate: () => Effect.Effect<boolean>, message: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (yield* predicate()) return;
      yield* Effect.sleep(30);
    }
    return yield* Effect.die(message);
  }).pipe(Effect.timeout("5 seconds"));

const makeProbe = Effect.fn(function* (identity: RunnerIdentity) {
  const stops: string[] = [];
  const artifactOffsets: number[] = [];
  const watches: Deferred.Deferred<void>[] = [];
  return {
    identity,
    events: yield* Queue.unbounded<typeof RunnerStateEvent.Type>(),
    identifyCalls: 0,
    watchCalls: 0,
    stops,
    artifactOffsets,
    watches,
    closed: yield* Deferred.make<void>(),
    closeCode: yield* Deferred.make<number>(),
  };
});
type Probe = Effect.Success<ReturnType<typeof makeProbe>>;

function controlHandlers(probe: Probe) {
  const unused = () => Effect.die("Unexpected runner command");
  return RunnerApi.toLayer(RunnerApi.of({
    "runner.identify": () => Effect.sync(() => (probe.identifyCalls++, probe.identity)),
    "runner.watch": () => {
      probe.watchCalls++;
      return Stream.fromQueue(probe.events);
    },
    "session.provision": unused,
    "session.prompt": unused,
    "session.thinking-level.set": unused,
    "session.wake": unused,
    "session.abort": unused,
    "session.git-snapshot.read": unused,
    "session.git-file.update": unused,
    "session.stop": ({ sessionId }) =>
      Effect.sync(() => {
        probe.stops.push(sessionId);
        return new StopSessionAccepted({});
      }),
    "session.delete": ({ sessionId }) =>
      Effect.sync(() => {
        assert(sessionId);
        return new DeleteSessionAccepted({});
      }),
    "session.watch": () =>
      Stream.unwrap(Effect.gen(function* () {
        const finalized = yield* Deferred.make<void>();
        probe.watches.push(finalized);
        return Stream.make({ event: { type: "git.snapshot.updated" as const } }).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(Deferred.succeed(finalized, undefined)),
        );
      })),
  }));
}

function bulkHandlers(probe: Probe) {
  return RunnerBulkApi.toLayer(RunnerBulkApi.of({
    "runner.bulk.identify": () => Effect.succeed(probe.identity),
    "runner.bulk.watch": () => {
      probe.watchCalls++;
      return Stream.make({ observedAt: 1 }).pipe(Stream.concat(Stream.never));
    },
    "session.git-patch.read-chunk": (input) =>
      Effect.succeed(
        new SessionGitPatchChunk({
          ...input,
          bytes: new Uint8Array([0, 255]),
          nextOffset: input.offset + 2,
          done: true,
        }),
      ),
    "session.artifact.read-chunk": ({ offset }) =>
      Effect.sync(() => {
        probe.artifactOffsets.push(offset);
        return new SessionArtifactChunk({
          artifact,
          offset,
          bytes: image.slice(offset, offset + MAX_RUNNER_BULK_CHUNK_BYTES),
        });
      }),
  }));
}

// Same synthetic outbound RPC-server adapter as runner-registry.test.ts, not a mock DO.
const connect = Effect.fn(function* (probe: Probe, bulk = false) {
  const url = endpoint(bulk ? "/api/runners/connect/bulk" : "/api/runners/connect");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const server = Layer.effect(
    SocketServer.SocketServer,
    Effect.map(Socket.Socket, (socket) => {
      const observe = <A, E, R>(effect: Effect.Effect<A, E | Socket.SocketError, R>) =>
        effect.pipe(
          Effect.tapError((error) =>
            Socket.isSocketError(error) && error.reason._tag === "SocketCloseError"
              ? Deferred.succeed(probe.closeCode, error.reason.code)
              : Effect.void
          ),
        );
      const observed = Socket.make({
        reader: observe(Effect.map(socket.reader, (reader) => ({
          ...reader,
          pull: observe(reader.pull),
        }))),
        writer: socket.writer,
      });
      return {
        address: NetAddress.socketAddressFromInputUnsafe({ address: "127.0.0.1", port: 0 }),
        run: (handler) =>
          handler(bulk ? observed : runnerControlWebSocket(observed)).pipe(
            Effect.ensuring(Deferred.succeed(probe.closed, undefined)),
            Effect.exit,
            Effect.andThen(Effect.never),
          ),
      } satisfies SocketServer.SocketServer["Service"];
    }),
  ).pipe(Layer.provide(DenoSocket.layerWebSocket(url.href)));
  const protocol = RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(server),
    Layer.provide(bulk ? runnerBulkRpcSerializationLayer : runnerControlRpcSerializationLayer),
  );
  const rpc = bulk
    ? RpcServer.layer(RunnerBulkApi).pipe(Layer.provide(bulkHandlers(probe)))
    : RpcServer.layer(RunnerApi).pipe(Layer.provide(controlHandlers(probe)));
  yield* Layer.launch(rpc.pipe(Layer.provide(protocol))).pipe(Effect.forkScoped);
});

const fixture = Effect.fn(function* () {
  assert(gatewayUrl);
  const workspace = createRpcClient(new URL("/__workspace", gatewayUrl).href);
  yield* Effect.promise(() => workspace.createAdministrator("rpc-fixture-password"));
  const identity = yield* Effect.promise(() =>
    workspace.verifyAdministratorPassword("rpc-fixture-password")
  );
  assert(identity, "use a fresh disposable celld fixture");
  const workspaceId = identity.workspaceId;
  const project = yield* Effect.promise(() =>
    workspace.saveProject(workspaceId, {
      name: `Native Runners ${crypto.randomUUID()}`,
      repositoryUrl: "https://github.com/example/native-rpc.git",
    })
  );
  assert(project.status === "saved");
  const enrollment = yield* Effect.promise(() => workspace.getRunnerEnrollmentToken(workspaceId));
  const enrolled = yield* Effect.promise(() =>
    workspace.enrollRunner({
      enrollmentPsk: enrollment.token,
      name: `Native ${crypto.randomUUID()}`,
      architecture: "x64",
    })
  );
  assert(enrolled);
  const runnerParams = { workspaceId, runnerId: enrolled.runnerId };
  const snapshots = [crypto.randomUUID(), crypto.randomUUID()].map((id) =>
    decode(RunnerSessionSnapshot)({
      id,
      projectId: project.project.id,
      createdAt: "2026-10-08T12:00:00Z",
      initialPromptPreview: "Native manifest",
      model: "openai/gpt-4.1",
      initialThinkingLevel: "medium",
      orbSize: "small",
      state: "ready",
      agentState: "idle",
      environmentState: "running",
      issues: [],
    })
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await workspace.revokeRunner(workspaceId, enrolled.runnerId);
      await json("/__registry/disconnect", {}, runnerParams);
      for (const session of snapshots) {
        await workspace.deleteSessionCatalogEntry(
          workspaceId,
          session.id,
          new Date().toISOString(),
        );
      }
      await workspace.deleteRunner(workspaceId, enrolled.runnerId);
      await workspace.deleteProject(workspaceId, project.project.id);
    }).pipe(Effect.timeout("5 seconds"), Effect.orDie)
  );
  const runnerIdentity = decode(RunnerIdentity)({
    token: enrolled.runnerToken,
    runnerId: enrolled.runnerId,
    runnerVersion: "native-test",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  const probe = yield* makeProbe(runnerIdentity);
  return { workspace, workspaceId, runnerParams, snapshots, probe };
});

const publish = (probe: Probe, sessions: RunnerSessionSnapshot[], revision = 1) =>
  Effect.forEach([
    ...sessions.map((session) => ({ type: "snapshot.session" as const, session })),
    {
      type: "snapshot.complete" as const,
      revision,
      sessionCount: sessions.length,
      observedAt: revision,
      capacity,
    },
  ], (event) =>
    Queue.offer(probe.events, decode(RunnerStateEvent)(event)), { discard: true });

const admitted = (params: Record<string, string>) =>
  eventually(
    () => Effect.promise(async () => await json("/__registry/live", params) !== null),
    "native control manifest was not admitted",
  );

Deno.test({
  name: "native celld Runners admits manifests, routes commands, replaces connections and revokes",
  ignore: !gatewayUrl,
  fn: () =>
    Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const [first, second] = f.snapshots;
        assert(first && second);
        yield* connect(f.probe);
        yield* eventually(
          () => Effect.sync(() => f.probe.watchCalls === 1),
          "runner.watch did not start",
        );
        assertEquals(yield* Effect.promise(() => json("/__registry/live", f.runnerParams)), null);
        yield* publish(f.probe, [first]);
        yield* admitted(f.runnerParams);
        const sessionParams = { workspaceId: f.workspaceId, sessionId: first.id };
        assertEquals(yield* Effect.promise(() => json("/__registry/snapshot", sessionParams)), {
          ...first,
        });
        assertEquals(yield* Effect.promise(() => json("/__registry/stop", {}, sessionParams)), {
          status: "accepted",
          acknowledgement: {},
        });
        assertEquals(f.probe.stops, [first.id]);
        assertEquals(f.probe.identifyCalls, 1);
        const foreign = { ...sessionParams, workspaceId: crypto.randomUUID() };
        assertEquals(yield* Effect.promise(() => json("/__registry/snapshot", foreign)), null);
        for (
          const identity of [
            decode(RunnerIdentity)({ ...f.probe.identity, token: "openorb_runner_invalid" }),
            decode(RunnerIdentity)({
              ...f.probe.identity,
              protocolVersion: RUNNER_PROTOCOL_VERSION - 1,
            }),
          ]
        ) {
          const rejected = yield* makeProbe(identity);
          yield* connect(rejected);
          assertEquals(
            yield* Deferred.await(rejected.closeCode).pipe(Effect.timeout("3 seconds")),
            4401,
          );
          assertEquals(rejected.watchCalls, 0);
        }
        const replacement = yield* makeProbe(f.probe.identity);
        yield* connect(replacement);
        yield* eventually(
          () => Effect.sync(() => replacement.watchCalls === 1),
          "replacement watch missing",
        );
        assertEquals(yield* Effect.promise(() => json("/__registry/snapshot", sessionParams)), {
          ...first,
        });
        yield* publish(replacement, [second], 10);
        yield* eventually(() =>
          Effect.promise(async () =>
            (await json("/__registry/snapshot", {
              workspaceId: f.workspaceId,
              sessionId: second.id,
            })) !== null
          ), "replacement manifest missing");
        assertEquals(
          yield* Effect.promise(() => json("/__registry/snapshot", sessionParams)),
          null,
        );
        assertEquals(
          yield* Effect.promise(() =>
            f.workspace.revokeRunner(f.workspaceId, f.runnerParams.runnerId)
          ),
          "revoked",
        );
        assertEquals(
          yield* Effect.promise(() => json("/__registry/disconnect", {}, f.runnerParams)),
          true,
        );
        assertEquals(yield* Effect.promise(() => json("/__registry/live", f.runnerParams)), null);
        assertEquals(
          yield* Effect.promise(() =>
            json("/__registry/snapshot", { workspaceId: f.workspaceId, sessionId: second.id })
          ),
          null,
        );
        const revoked = yield* makeProbe(f.probe.identity);
        yield* connect(revoked);
        assertEquals(
          yield* Deferred.await(revoked.closeCode).pipe(Effect.timeout("3 seconds")),
          4401,
        );
        assertEquals(revoked.watchCalls, 0);
      }).pipe(Effect.timeout("30 seconds")),
    )),
});

Deno.test({
  name: "native celld Runners bulk artifact RPC preserves Uint8Array and multi-chunk bytes",
  ignore: !gatewayUrl,
  fn: () =>
    Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const session = f.snapshots[0]!;
        yield* connect(f.probe);
        yield* publish(f.probe, [session]);
        yield* admitted(f.runnerParams);
        const bulk = yield* makeProbe(f.probe.identity);
        yield* connect(bulk, true);
        const input = {
          workspaceId: f.workspaceId,
          sessionId: session.id,
          artifactId: artifact.id,
          offset: 0,
        };
        let first: Uint8Array | undefined;
        yield* eventually(() =>
          Effect.promise(async () => {
            const response = await request("/__registry/artifact", {}, input);
            if (response.status === 409) {
              await response.text();
              return false;
            }
            assertEquals(response.status, 200, await response.clone().text());
            assertEquals(response.headers.get("x-native-byte-type"), "Uint8Array");
            assertEquals(response.headers.get("x-artifact-id"), artifact.id);
            assertEquals(response.headers.get("x-artifact-byte-length"), String(image.length));
            assertEquals(response.headers.get("x-artifact-offset"), "0");
            first = new Uint8Array(await response.arrayBuffer());
            return true;
          }), "native bulk artifact RPC was not admitted");
        assert(first);
        assertEquals(first, image.slice(0, MAX_RUNNER_BULK_CHUNK_BYTES));
        const offset = first.length;
        const response = yield* Effect.promise(() =>
          request("/__registry/artifact", {}, { ...input, offset })
        );
        assertEquals(response.status, 200);
        assertEquals(response.headers.get("x-native-byte-type"), "Uint8Array");
        assertEquals(response.headers.get("x-artifact-offset"), String(first.length));
        const tail = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
        assertEquals(new Uint8Array([...first, ...tail]), image);
        assertEquals(bulk.artifactOffsets, [0, MAX_RUNNER_BULK_CHUNK_BYTES]);
        assertEquals(
          yield* Effect.promise(() => json("/__registry/disconnect", {}, f.runnerParams)),
          true,
        );
        assertEquals(yield* Effect.promise(() => json("/__registry/live", f.runnerParams)), null);
      }).pipe(Effect.timeout("20 seconds")),
    )),
});

Deno.test({
  name: "native celld Runners SSE reader cancellation reaches only its runner watch finalizer",
  ignore: !gatewayUrl,
  fn: () =>
    Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* connect(f.probe);
        yield* publish(f.probe, [f.snapshots[0]!]);
        yield* admitted(f.runnerParams);
        const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
        for (let i = 0; i < 2; i++) {
          const controller = new AbortController();
          const response = yield* Effect.acquireRelease(
            Effect.promise(() =>
              fetch(
                endpoint("/__registry/watch", {
                  workspaceId: f.workspaceId,
                  sessionId: f.snapshots[0]!.id,
                }),
                { signal: controller.signal },
              )
            ),
            () => Effect.sync(() => controller.abort()),
          );
          assertEquals(response.status, 200);
          assert(response.headers.get("content-type")?.startsWith("text/event-stream"));
          assert(response.body);
          const reader = response.body.getReader();
          readers.push(reader);
          const initial = yield* Effect.promise(() => reader.read()).pipe(
            Effect.timeout("3 seconds"),
          );
          assert(!initial.done);
          assert(
            new TextDecoder().decode(initial.value).includes(
              'event: session\ndata: {"type":"git.snapshot.updated"}',
            ),
          );
        }
        assertEquals(f.probe.watches.length, 2);
        yield* Effect.promise(() => readers[0]!.cancel()).pipe(
          Effect.timeout("3 seconds"),
          Effect.catch(() => Effect.die("SSE reader.cancel() did not complete")),
        );
        yield* Deferred.await(f.probe.watches[0]!).pipe(
          Effect.timeout("3 seconds"),
          Effect.catch(() => Effect.die("SSE cancellation did not finalize its runner watch")),
        );
        assert(Option.isNone(yield* Deferred.poll(f.probe.watches[1]!)));
        yield* Effect.promise(() => readers[1]!.cancel());
        yield* Deferred.await(f.probe.watches[1]!).pipe(
          Effect.timeout("3 seconds"),
          Effect.catch(() =>
            Effect.die("Second SSE cancellation did not finalize its runner watch")
          ),
        );
      }).pipe(Effect.timeout("20 seconds")),
    )),
});

Deno.test({
  name: "native celld Runners revocation closes control and bulk peer connections",
  ignore: !gatewayUrl,
  fn: () =>
    Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* connect(f.probe);
        yield* publish(f.probe, [f.snapshots[0]!]);
        yield* admitted(f.runnerParams);
        const bulk = yield* makeProbe(f.probe.identity);
        yield* connect(bulk, true);
        yield* eventually(
          () => Effect.sync(() => bulk.watchCalls === 1),
          "bulk watch did not start",
        );
        assertEquals(
          yield* Effect.promise(() =>
            f.workspace.revokeRunner(f.workspaceId, f.runnerParams.runnerId)
          ),
          "revoked",
        );
        assertEquals(
          yield* Effect.promise(() => json("/__registry/disconnect", {}, f.runnerParams)),
          true,
        );
        assertEquals(yield* Effect.promise(() => json("/__registry/live", f.runnerParams)), null);
        yield* eventually(() =>
          Effect.gen(function* () {
            const controlClosed = Option.isSome(yield* Deferred.poll(f.probe.closed));
            const bulkClosed = Option.isSome(yield* Deferred.poll(bulk.closed));
            return controlClosed && bulkClosed;
          }), "Revocation did not close peer WebSockets").pipe(
            Effect.catchCause(() =>
              Effect.gen(function* () {
                const controlClosed = Option.isSome(yield* Deferred.poll(f.probe.closed));
                const bulkClosed = Option.isSome(yield* Deferred.poll(bulk.closed));
                return yield* Effect.die(
                  `Revocation removed registry state but peer cleanup failed: controlClosed=${controlClosed}, bulkClosed=${bulkClosed}`,
                );
              })
            ),
          );
      }).pipe(Effect.timeout("20 seconds")),
    )),
});
