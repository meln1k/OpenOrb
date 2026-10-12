import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import * as DenoFileSystem from "@effect/platform-deno/DenoFileSystem";
import * as DenoPath from "@effect/platform-deno/DenoPath";
import { ok } from "@openorb/result";
import {
  CapacityExceeded,
  ControlEnvironmentPayload,
  CreateEnvironmentPayload,
  EnvironmentRejected,
  GitAuthor,
  RunnerId,
  SessionId,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Effect, Exit, Layer, Predicate, Scope } from "effect";
import {
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
  type EnvironmentDaemon,
} from "../../../src/environment/agent-environment.ts";
import { EnvironmentStore, environmentStoreLayer } from "../../../src/environment/session/store.ts";
import {
  type EnvironmentSupervisor,
  makeEnvironmentSupervisor,
} from "../../../src/environment/session/supervisor.ts";
import { FakeEnvironment } from "../fake-environment.ts";

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134d10");
const RUNNER_ID = RunnerId.make("01989d78-65ee-7f6a-a97e-0f16ad134d09");
const WORKSPACE_ID = WorkspaceId.make("01989d78-65ee-7f6a-a97e-0f16ad134d12");
const TOKEN = "openorb_runner_test";
const NONCE = "A".repeat(43);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const create = (orbSize: "small" | "xxlarge" = "small") =>
  new CreateEnvironmentPayload({
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    orbSize,
    repository: {
      url: "https://github.com/meln1k/openorb-test-repo.git",
      gitAuthor: new GitAuthor({ name: "Tester", email: "test@example.com" }),
    },
  });
const control = (
  action: "start" | "stop" | "restart",
  extra: Partial<{ githubToken: string; recovery: "restart-environment" }> = {},
) => new ControlEnvironmentPayload({ sessionId: SESSION_ID, action, ...extra });

type FrameFields = Readonly<Record<string, string | number>>;

function frame(type: number, id: number, json: FrameFields): Uint8Array<ArrayBuffer> {
  const body = encoder.encode(JSON.stringify(json));
  const bytes = new Uint8Array(13 + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 9 + body.length);
  view.setUint8(4, type);
  view.setUint32(5, id);
  view.setUint32(9, body.length);
  bytes.set(body, 13);
  return bytes;
}

/** A guest daemon that answers `hello` like pi-env and records when it is closed. */
class FakeDaemon implements EnvironmentDaemon {
  readonly token = "fake-token";
  closed = false;
  #output!: ReadableStreamDefaultController<Uint8Array>;
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.#output = controller;
      controller.enqueue(encoder.encode(`PI-ENV ${this.token}\n`));
    },
  });
  write = (bytes: Uint8Array) => {
    const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(5);
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(9);
    const json = JSON.parse(decoder.decode(bytes.subarray(13, 13 + length)));
    if (json.op === "hello") this.#output.enqueue(frame(2, id, { protocol: 1, os: "linux" }));
  };
  close = Effect.sync(() => {
    if (this.closed) return;
    this.closed = true;
    this.#output.close();
  });
}

class DaemonEnvironment extends FakeEnvironment {
  readonly daemons: FakeDaemon[] = [];
  override startDaemon = Effect.sync(() => {
    const daemon = new FakeDaemon();
    this.daemons.push(daemon);
    return daemon;
  });
}

interface ReceivedFrames {
  attach?: unknown;
  reply?: Uint8Array;
  pong?: boolean;
}

interface Fixture {
  readonly directory: string;
  readonly environments: DaemonEnvironment[];
  readonly made: AgentEnvironmentOptions[];
  readonly open: (gatewayUrl?: string) => Promise<{
    supervisor: EnvironmentSupervisor;
    close: () => Promise<void>;
  }>;
}

async function withFixture(test: (fixture: Fixture) => Promise<void>) {
  const directory = await Deno.makeTempDir({ prefix: "openorb-environments-" });
  const environments: DaemonEnvironment[] = [];
  const made: AgentEnvironmentOptions[] = [];
  const provider = Layer.succeed(
    AgentEnvironmentProvider,
    AgentEnvironmentProvider.of({
      initializeRootDisk: (path) => Effect.promise(() => Deno.writeFile(path, new Uint8Array())),
      make: (options) =>
        Effect.sync(() => {
          made.push(options);
          const environment = new DaemonEnvironment();
          environments.push(environment);
          return environment;
        }),
    }),
  );
  const open = async (gatewayUrl = "http://127.0.0.1:1") => {
    const scope = await Effect.runPromise(Scope.make());
    const supervisor = await Effect.runPromise(
      makeEnvironmentSupervisor({
        runnerId: RUNNER_ID,
        cpuCount: 4,
        memoryMiB: 8192,
        gatewayUrl,
        runnerToken: TOKEN,
        assertDetached: () => Promise.resolve(ok(undefined)),
      }).pipe(
        Effect.provide(
          Layer.merge(provider, environmentStoreLayer(directory)).pipe(
            Layer.provide(Layer.merge(DenoFileSystem.layer, DenoPath.layer)),
          ),
        ),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    return { supervisor, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  };
  try {
    await test({ directory, environments, made, open });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("creating an environment is idempotent and checks capacity and conflicts", () =>
  withFixture(async ({ open }) => {
    const { supervisor, close } = await open();
    try {
      const created = await Effect.runPromise(supervisor.create(create()));
      assertEquals(created.state, "stopped");
      assertEquals(await Effect.runPromise(supervisor.create(create())), created);
      const conflict = await Effect.runPromise(Effect.flip(supervisor.create(create("xxlarge"))));
      assertInstanceOf(conflict, CapacityExceeded);
      assertEquals(supervisor.snapshots(), [created]);
    } finally {
      await close();
    }
  }));

Deno.test("start passes mediation inputs to the provider and stop records a clean stop", () =>
  withFixture(async ({ open, made, environments }) => {
    const { supervisor, close } = await open();
    try {
      await Effect.runPromise(supervisor.create(create()));
      const started = await Effect.runPromise(
        supervisor.control(control("start", { githubToken: "gh-secret" })),
      );
      assertEquals(started.state, "running");
      assertEquals(made[0]?.github?.token, "gh-secret");
      assertEquals(
        made[0]?.github?.repositoryUrl,
        "https://github.com/meln1k/openorb-test-repo.git",
      );
      assertEquals(environments[0]?.commands[0], ["/bin/true"]);
      const stopped = await Effect.runPromise(supervisor.control(control("stop")));
      assertEquals({ ...stopped }, { state: "stopped", forced: false });
      assertEquals(supervisor.snapshots()[0]?.state, "stopped");
      assertEquals(supervisor.activeCount(), 0);
    } finally {
      await close();
    }
  }));

Deno.test("an environment without a project gets no GitHub mediation, even with a token", () =>
  withFixture(async ({ open, made }) => {
    const { supervisor, close } = await open();
    try {
      const { repository: _repository, ...withoutProject } = create();
      await Effect.runPromise(supervisor.create(new CreateEnvironmentPayload(withoutProject)));
      const started = await Effect.runPromise(
        supervisor.control(control("start", { githubToken: "gh-secret" })),
      );
      assertEquals(started.state, "running");
      assertEquals(made[0]?.github, undefined);
    } finally {
      await close();
    }
  }));

Deno.test("an interrupted environment restores as failed and requires an explicit restart", () =>
  withFixture(async ({ open, directory }) => {
    const first = await open();
    await Effect.runPromise(first.supervisor.create(create()));
    await first.close();
    // Simulate a runner crash while the VM ran: the journal says running, but no VM survived.
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* EnvironmentStore;
        const replayed = yield* store.replay(SESSION_ID);
        yield* store.append(SESSION_ID, replayed!.sequence, {
          type: "environment.changed",
          state: "running",
        });
      }).pipe(
        Effect.provide(
          environmentStoreLayer(directory).pipe(
            Layer.provide(Layer.merge(DenoFileSystem.layer, DenoPath.layer)),
          ),
        ),
      ),
    );
    const { supervisor, close } = await open();
    try {
      const restored = supervisor.snapshots()[0]!;
      assertEquals(restored.state, "error");
      assertEquals(restored.recovery, "restart-environment");
      const refused = await Effect.runPromise(Effect.flip(supervisor.control(control("start"))));
      assertInstanceOf(refused, EnvironmentRejected);
      const recovered = await Effect.runPromise(
        supervisor.control(control("start", { recovery: "restart-environment" })),
      );
      assertEquals(recovered.state, "running");
    } finally {
      await close();
    }
  }));

Deno.test("attaching a stopped environment fails immediately", () =>
  withFixture(async ({ open }) => {
    const { supervisor, close } = await open();
    try {
      await Effect.runPromise(supervisor.create(create()));
      const refused = await Effect.runPromise(Effect.flip(supervisor.attach(SESSION_ID, NONCE)));
      assertInstanceOf(refused, EnvironmentRejected);
      assert(refused.message.includes("stopped"));
    } finally {
      await close();
    }
  }));

Deno.test("attach dials the link, authenticates in-band and relays daemon frames", () =>
  withFixture(async ({ open, environments }) => {
    // SAFETY: every field of ReceivedFrames is optional; the server fills them as frames arrive.
    const received = {} as ReceivedFrames;
    let gatewaySocket: WebSocket | undefined;
    const replied = Promise.withResolvers<void>();
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (request) => {
      assertEquals(
        new URL(request.url).pathname,
        `/api/runners/environments/${SESSION_ID}/link`,
      );
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.binaryType = "arraybuffer";
      gatewaySocket = socket;
      socket.onmessage = (event) => {
        if (Predicate.isString(event.data)) {
          if (event.data === "ping") {
            received.pong = true;
            socket.send("pong");
            return;
          }
          received.attach = JSON.parse(event.data);
          socket.send("attached");
          // Act as the Session Durable Object's client: a hello request through the relay.
          socket.send(frame(1, 41, { op: "hello", protocol: 1 }));
          return;
        }
        received.reply = new Uint8Array(event.data);
        replied.resolve();
      };
      return response;
    });
    const { supervisor, close } = await open(`http://127.0.0.1:${server.addr.port}`);
    try {
      await Effect.runPromise(supervisor.create(create()));
      await Effect.runPromise(supervisor.control(control("start")));
      await Effect.runPromise(supervisor.attach(SESSION_ID, NONCE));
      await replied.promise;
      assertEquals(received.attach, { type: "attach", token: TOKEN, nonce: NONCE });
      assertEquals(new DataView(received.reply!.buffer).getUint32(5), 41);
      const daemon = environments[0]!.daemons[0]!;
      assert(!daemon.closed);
      // Losing the link closes the daemon, which kills what it started.
      gatewaySocket!.close();
      for (let attempt = 0; attempt < 200 && !daemon.closed; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(daemon.closed);
    } finally {
      await close();
      await server.shutdown();
    }
  }));

Deno.test("deleting an environment stops compute and removes its storage", () =>
  withFixture(async ({ open, directory, environments }) => {
    const { supervisor, close } = await open();
    try {
      await Effect.runPromise(supervisor.create(create()));
      await Effect.runPromise(supervisor.control(control("start")));
      await Effect.runPromise(supervisor.delete(SESSION_ID));
      assertEquals(supervisor.snapshots(), []);
      assertEquals(environments[0]?.stops, 1);
      const entries = [...Deno.readDirSync(`${directory}/environments`)];
      assertEquals(entries, []);
      const recreated = await Effect.runPromise(Effect.flip(supervisor.attach(SESSION_ID, NONCE)));
      assertEquals(recreated._tag, "EnvironmentNotFound");
      // A fresh create after deletion is a new environment, not a conflict.
      const again = await Effect.runPromise(supervisor.create(create()));
      assertEquals(again.state, "stopped");
    } finally {
      await close();
    }
  }));
