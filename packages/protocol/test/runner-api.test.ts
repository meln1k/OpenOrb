import { test } from "vite-plus/test";
import { assert, assertEquals, assertThrows } from "@jsr/std__assert";
import { Effect, Schema, type Scope, Stream } from "effect";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  type CapacityExceeded,
  ControlEnvironmentPayload,
  CreateEnvironmentPayload,
  DeleteEnvironmentPayload,
  type DeleteFailed,
  EnvironmentControlled,
  EnvironmentCreated,
  EnvironmentDeleted,
  type EnvironmentNotFound,
  type EnvironmentRejected,
  GitAuthor,
  RUNNER_PROTOCOL_VERSION,
  RunnerApi,
  RunnerCapacity,
  RunnerEnvironmentSnapshot,
  RunnerId,
  RunnerIdentity,
  type RunnerIdentityError,
  type RunnerWatchError,
  type SessionConflict,
  SessionEnvironmentSecret,
  SessionEnvironmentSecrets,
  SessionId,
} from "../src/runner-api.ts";
import {
  MAX_RUNNER_RPC_FRAME_BYTES,
  MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES,
} from "../src/runner-api-limits.ts";

type RunnerApiError =
  | CapacityExceeded
  | DeleteFailed
  | EnvironmentNotFound
  | EnvironmentRejected
  | RunnerIdentityError
  | RunnerWatchError
  | SessionConflict;

const SESSION_ID = SessionId.make("01989d78-65ee-7f6a-a97e-0f16ad134c09");
const RUNNER_ID = RunnerId.make("01989d78-65ee-7f6a-a97e-0f16ad134c11");
const RUNNER_TOKEN = `openorb_runner_${"a".repeat(43)}`;

test("RunnerApi schemas bound identity and stable domain identifiers", () => {
  assertEquals(
    Schema.decodeUnknownSync(RunnerIdentity)({
      token: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      runnerVersion: "0.0.0",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    }).runnerId,
    RUNNER_ID,
  );
  assertThrows(() =>
    Schema.decodeUnknownSync(RunnerIdentity)({
      token: "not-a-runner-token",
      runnerId: RUNNER_ID,
      runnerVersion: "0.0.0",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
    }),
  );
  const created = Schema.decodeUnknownSync(CreateEnvironmentPayload)({
    sessionId: SESSION_ID,
    orbSize: "medium",
    repository: {
      url: "https://github.com/openorb/example.git",
      gitAuthor: { name: "OpenOrb User", email: "user@example.com" },
    },
  });
  assertEquals(created.orbSize, "medium");
  const { repository: _repository, ...withoutProject } = created;
  // A Session without a project sends no repository at all, never half of one.
  assertEquals(
    Schema.decodeUnknownSync(CreateEnvironmentPayload)(withoutProject).repository,
    undefined,
  );
  for (const repository of [
    { ...created.repository, url: "https://example.com/openorb/example.git" },
    { ...created.repository, gitAuthor: { name: "OpenOrb User", email: "not-an-email" } },
    { url: "https://github.com/openorb/example.git" },
  ]) {
    assertThrows(() =>
      Schema.decodeUnknownSync(CreateEnvironmentPayload)({ ...created, repository }),
    );
  }

  const started = Schema.decodeUnknownSync(ControlEnvironmentPayload)({
    sessionId: SESSION_ID,
    action: "start",
    githubToken: "github-token",
    environmentSecrets: [
      {
        name: "SERVICE_TOKEN",
        value: "service-secret",
        allowedHosts: ["api.example.com", "*.service.example"],
      },
    ],
  });
  assertEquals(started.environmentSecrets, [
    new SessionEnvironmentSecret({
      name: "SERVICE_TOKEN",
      value: "service-secret",
      allowedHosts: ["api.example.com", "*.service.example"],
    }),
  ]);
  for (const environmentSecrets of [
    [{ name: "GH_TOKEN", value: "collision" }],
    [
      { name: "SERVICE_TOKEN", value: "one" },
      { name: "SERVICE_TOKEN", value: "two" },
    ],
    [{ name: "SERVICE_TOKEN", value: "secret", allowedHosts: ["https://api.example.com"] }],
  ]) {
    assertThrows(() =>
      Schema.decodeUnknownSync(ControlEnvironmentPayload)({ ...started, environmentSecrets }),
    );
  }
  assertThrows(() =>
    Schema.decodeUnknownSync(ControlEnvironmentPayload)({ ...started, action: "suspend" }),
  );
  assertEquals(RUNNER_PROTOCOL_VERSION, 29);
});

test("environment secrets reserve enough room for the RPC request envelope", () => {
  const maximumLengthHost = (index: number) =>
    `${index.toString(36).padStart(2, "0")}.${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(
      58,
    )}`;
  const environmentSecrets = (hostCount: number) =>
    Array.from({ length: 64 }, (_, secretIndex) => ({
      name: `SERVICE_TOKEN_${secretIndex}`,
      value: "x".repeat(4_096),
      allowedHosts: Array.from({ length: hostCount }, (_, hostIndex) =>
        maximumLengthHost(hostIndex),
      ),
    }));

  assertEquals(maximumLengthHost(0).length, 253);
  const acceptedSecrets = Schema.decodeUnknownSync(SessionEnvironmentSecrets)(
    environmentSecrets(31),
  );
  assert(byteLength(JSON.stringify(acceptedSecrets)) < MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES);

  const payload = Schema.decodeUnknownSync(ControlEnvironmentPayload)({
    sessionId: SESSION_ID,
    action: "restart",
    githubToken: "\0".repeat(4_096),
    environmentSecrets: acceptedSecrets,
  });
  const frame = {
    _tag: "Request",
    id: Number.MAX_SAFE_INTEGER,
    tag: "environment.control",
    payload,
    headers: [],
    traceId: "f".repeat(32),
    spanId: "f".repeat(16),
    sampled: true,
  };
  assert(byteLength(JSON.stringify(frame)) <= MAX_RUNNER_RPC_FRAME_BYTES);

  const oversizedSecrets = environmentSecrets(32);
  const oversizedBytes = byteLength(JSON.stringify(oversizedSecrets));
  assert(oversizedBytes > MAX_SESSION_ENVIRONMENT_SECRETS_JSON_BYTES);
  assert(oversizedBytes < MAX_RUNNER_RPC_FRAME_BYTES);
  assertThrows(() => Schema.decodeUnknownSync(SessionEnvironmentSecrets)(oversizedSecrets));
});

test("RunnerApi exposes only runner and environment procedures through RpcTest", async () => {
  const identity = new RunnerIdentity({
    token: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    runnerVersion: "0.0.0",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
  });
  const capacity = runnerCapacity();
  const environment = new RunnerEnvironmentSnapshot({ sessionId: SESSION_ID, state: "stopped" });
  assertEquals(Array.from(RunnerApi.requests.keys()).sort(), [
    "environment.control",
    "environment.create",
    "environment.delete",
    "runner.identify",
    "runner.watch",
  ]);
  const handlers = RunnerApi.toLayer({
    "runner.identify": () => Effect.succeed(identity),
    "runner.watch": () =>
      Stream.make(
        { type: "snapshot" as const, observedAt: 1, capacity, environments: [environment] },
        { type: "environment.changed" as const, environment },
      ),
    "environment.create": () => Effect.succeed(new EnvironmentCreated({ environment })),
    "environment.control": ({ action }) =>
      Effect.succeed(
        new EnvironmentControlled({
          state: action === "stop" ? "stopped" : "running",
          forced: false,
        }),
      ),
    "environment.delete": () => Effect.succeed(new EnvironmentDeleted({})),
  });

  const createPayload = new CreateEnvironmentPayload({
    sessionId: SESSION_ID,
    orbSize: "small",
    repository: {
      url: "https://github.com/acme/repo.git",
      gitAuthor: new GitAuthor({ name: "Ada", email: "ada@example.com" }),
    },
  });
  const controlPayload = new ControlEnvironmentPayload({
    sessionId: SESSION_ID,
    action: "start",
    githubToken: "github-token",
  });
  const deletePayload = new DeleteEnvironmentPayload({ sessionId: SESSION_ID });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* (): Effect.fn.Return<void, RunnerApiError, Scope.Scope> {
        const client = yield* RpcTest.makeClient(RunnerApi).pipe(Effect.provide(handlers));
        assertEquals((yield* client["runner.identify"]()).runnerId, RUNNER_ID);
        assertEquals(
          Array.from(yield* client["runner.watch"]().pipe(Stream.runCollect)).map(
            (event) => event.type,
          ),
          ["snapshot", "environment.changed"],
        );
        assertEquals(
          (yield* client["environment.create"](createPayload)).environment.sessionId,
          SESSION_ID,
        );
        assertEquals((yield* client["environment.control"](controlPayload)).state, "running");
        assert((yield* client["environment.delete"](deletePayload)) instanceof EnvironmentDeleted);
      }),
    ),
  );
});

function runnerCapacity(): RunnerCapacity {
  return new RunnerCapacity({
    activeSessions: 1,
    vmCpuCount: 4,
    vmMemoryMiB: 8_192,
    diskFreeMiB: 100_000,
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
