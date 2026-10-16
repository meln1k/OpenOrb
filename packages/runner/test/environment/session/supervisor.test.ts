import { test } from "vite-plus/test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { assert, assertEquals, assertInstanceOf } from "@jsr/std__assert";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { ok } from "@openorb/result";
import {
  CapacityExceeded,
  ControlEnvironmentPayload,
  CreateEnvironmentPayload,
  GitAuthor,
  RunnerId,
  SessionId,
} from "@openorb/protocol/runner-api";
import { Effect, Exit, Layer, Predicate, Scope } from "effect";
import {
  type AgentEnvironmentOptions,
  AgentEnvironmentProvider,
  type EnvironmentDaemon,
} from "../../../src/environment/agent-environment.ts";
import { environmentStoreLayer } from "../../../src/environment/session/store.ts";
import {
  type EnvironmentSupervisor,
  makeEnvironmentSupervisor,
} from "../../../src/environment/session/supervisor.ts";
import { FakeEnvironment } from "../fake-environment.ts";

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134d10");
const RUNNER_ID = RunnerId.make("01989d78-65ee-7f6a-a97e-0f16ad134d09");
const TOKEN = "openorb_runner_test";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const create = (orbSize: "small" | "xxlarge" = "small") =>
  new CreateEnvironmentPayload({
    sessionId: SESSION_ID,
    orbSize,
    repository: {
      url: "https://github.com/meln1k/openorb-test-repo.git",
      gitAuthor: new GitAuthor({ name: "Tester", email: "test@example.com" }),
    },
  });
const control = (
  action: "start" | "stop" | "restart",
  extra: Partial<{ githubToken: string }> = {},
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
  const directory = await fs.mkdtemp(join(tmpdir(), "openorb-environments-"));
  const environments: DaemonEnvironment[] = [];
  const made: AgentEnvironmentOptions[] = [];
  const provider = Layer.succeed(
    AgentEnvironmentProvider,
    AgentEnvironmentProvider.of({
      initializeRootDisk: (path) => Effect.promise(() => fs.writeFile(path, new Uint8Array())),
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
            Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
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
    await fs.rm(directory, { recursive: true });
  }
}

test("creating an environment is idempotent and checks capacity and conflicts", () =>
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

test("start passes mediation inputs to the provider and stop records a clean stop", () =>
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

test("an environment without a project gets no GitHub mediation, even with a token", () =>
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

test("environments restore stopped and an unacknowledged creation is discarded", () =>
  withFixture(async ({ open, directory }) => {
    const first = await open();
    await Effect.runPromise(first.supervisor.create(create()));
    await Effect.runPromise(first.supervisor.control(control("start")));
    await first.close();
    // A creation interrupted before its definition was published, and a disk without one.
    const orphan = "01989d78-65ee-7f6a-a97e-0f16ad134d11";
    await fs.mkdir(`${directory}/environments/${orphan}`);
    const undefinedDisk = "01989d78-65ee-7f6a-a97e-0f16ad134d13";
    await fs.mkdir(`${directory}/environments/${undefinedDisk}`);
    await fs.writeFile(
      `${directory}/environments/${undefinedDisk}/root-disk.qcow2`,
      new Uint8Array(),
    );
    const { supervisor, close } = await open();
    try {
      assertEquals(
        supervisor.snapshots().map((x) => ({ ...x })),
        [{ sessionId: SESSION_ID, state: "stopped" }],
      );
      assertEquals(
        (await fs.readdir(`${directory}/environments`)).sort(),
        [SESSION_ID, undefinedDisk],
        "only the empty interrupted creation is removed",
      );
      const started = await Effect.runPromise(supervisor.control(control("start")));
      assertEquals(started.state, "running");
    } finally {
      await close();
    }
  }));

test("a running environment keeps its link dialed and relays daemon frames", () =>
  withFixture(async ({ open, environments }) => {
    const attaches: unknown[] = [];
    const sockets: WebSocket[] = [];
    const replies: Uint8Array[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket, request) => {
      assertEquals(
        new URL(request.url!, "http://127.0.0.1").pathname,
        `/api/runners/environments/${SESSION_ID}/link`,
      );
      socket.binaryType = "arraybuffer";
      sockets.push(socket);
      socket.onmessage = (event) => {
        if (Predicate.isString(event.data)) {
          if (event.data === "ping") {
            socket.send("pong");
            return;
          }
          attaches.push(JSON.parse(event.data));
          socket.send("attached");
          // Act as the Session Durable Object's client: a hello request through the relay.
          socket.send(frame(1, 41, { op: "hello", protocol: 1 }));
          return;
        }
        const data = event.data;
        replies.push(
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data),
        );
      };
    });
    await once(server, "listening");
    const address = server.address();
    // oxlint-disable-next-line openorb/no-runtime-typeof -- Validate Node's socket address union at the listener I/O boundary.
    assert(typeof address === "object" && address !== null);
    const until = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(condition());
    };
    const { supervisor, close } = await open(`http://127.0.0.1:${address.port}`);
    try {
      await Effect.runPromise(supervisor.create(create()));
      await Effect.runPromise(supervisor.control(control("start")));
      await until(() => replies.length === 1);
      assertEquals(attaches, [{ type: "attach", token: TOKEN }]);
      assertEquals(new DataView(replies[0]!.buffer).getUint32(5), 41);
      const first = environments[0]!.daemons[0]!;
      assert(!first.closed);
      // Losing the link closes the daemon, which kills what it started, and the runner redials.
      sockets[0]!.close();
      await until(() => first.closed);
      await until(() => replies.length === 2);
      const second = environments[0]!.daemons[1]!;
      await Effect.runPromise(supervisor.control(control("stop")));
      assert(second.closed);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assertEquals(sockets.length, 2, "a stopped environment dials no link");
    } finally {
      await close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }));

test("deleting an environment stops compute and removes its storage", () =>
  withFixture(async ({ open, directory, environments }) => {
    const { supervisor, close } = await open();
    try {
      await Effect.runPromise(supervisor.create(create()));
      await Effect.runPromise(supervisor.control(control("start")));
      await Effect.runPromise(supervisor.delete(SESSION_ID));
      assertEquals(supervisor.snapshots(), []);
      assertEquals(environments[0]?.stops, 1);
      const entries = await fs.readdir(`${directory}/environments`);
      assertEquals(entries, []);
      const gone = await Effect.runPromise(Effect.flip(supervisor.control(control("start"))));
      assertEquals(gone._tag, "EnvironmentNotFound");
      // A fresh create after deletion is a new environment, not a conflict.
      const again = await Effect.runPromise(supervisor.create(create()));
      assertEquals(again.state, "stopped");
    } finally {
      await close();
    }
  }));
