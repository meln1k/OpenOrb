import { assert, assertEquals } from "@std/assert";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Predicate,
  Queue,
  Result,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import {
  type AdmissionPolicy,
  BOOTSTRAP_TIMEOUT_CLOSE_CODE,
  DEFAULT_PROOF_FRAME_LIMIT,
  FRAME_LIMIT_CLOSE_CODE,
  maintainProofRunner,
  makeProofGateway,
  makeRunnerProbe,
  PERMANENT_REJECTION_CLOSE_CODE,
  ProofRunnerApi,
  ProofRunnerIdentity,
} from "@/test/connection/effect-v4-transport-proof.ts";

const RUNNER_TOKEN = `openorb_runner_${"a".repeat(43)}`;
const RUNNER_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c09";
const RUNNER_VERSION = "0.0.0-proof";
const PROTOCOL_VERSION = 2;
type TestError = RpcClientError | Socket.SocketError;

Deno.test("inverted Effect RPC preserves eager identity, unary calls, and stream cancellation", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
    void,
    TestError,
    Scope.Scope
  > {
    const gateway = yield* makeProofGateway();
    const authenticationGate = yield* Deferred.make<void>();
    yield* Queue.offer(gateway.policies, admissionPolicy({ authenticationGate }));
    const probe = yield* makeRunnerProbe(runnerIdentity());
    const runner = yield* maintainProofRunner({
      socketUrl: gateway.socketUrl,
      probe,
      maxReconnects: 0,
    }).pipe(Effect.forkScoped);

    yield* Deferred.await(probe.identifyResponded);
    assertEquals(probe.calls, { identify: 1, echo: 0, hang: 0, watch: 0 });
    assertEquals(Queue.takeUnsafe(gateway.connections), undefined);

    yield* Deferred.succeed(authenticationGate, undefined);
    const connection = yield* Queue.take(gateway.connections);
    assertEquals(yield* Queue.take(gateway.outcomes), { status: "admitted" });
    assertEquals(connection.identity.runnerId, RUNNER_ID);
    assertEquals(
      yield* connection.client["proof.echo"]({ value: "gateway-to-runner" }),
      "gateway-to-runner",
    );

    const observations = yield* connection.client["runner.watch"](undefined, {
      streamBufferSize: 1,
    }).pipe(
      Stream.take(1),
      Stream.runCollect,
    );
    assertEquals(Array.from(observations), [1]);
    yield* Queue.take(probe.watchFinalized);
    assertEquals(probe.calls.watch, 1);

    yield* connection.close(1000, "Proof complete");
    assertEquals(yield* Fiber.join(runner), {
      status: "retries-exhausted",
      closeCode: 1000,
      attempts: 1,
    });
  })));
});

Deno.test("identity rejection closes with 4401 and never calls a non-bootstrap procedure", async () => {
  const cases = [
    {
      name: "invalid token",
      identity: runnerIdentity({ token: `openorb_runner_${"b".repeat(43)}` }),
    },
    {
      name: "claimed runner id mismatch",
      identity: runnerIdentity({ runnerId: "01989d78-65ee-7f6a-a97e-0f16ad134c10" }),
    },
    {
      name: "protocol version mismatch",
      identity: runnerIdentity({ protocolVersion: PROTOCOL_VERSION + 1 }),
    },
  ];

  for (const testCase of cases) {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
      void,
      TestError,
      Scope.Scope
    > {
      const gateway = yield* makeProofGateway();
      yield* Queue.offer(gateway.policies, admissionPolicy());
      const probe = yield* makeRunnerProbe(testCase.identity);

      const result = yield* maintainProofRunner({
        socketUrl: gateway.socketUrl,
        probe,
        maxReconnects: 5,
      });

      assertEquals(result, {
        status: "permanent-rejection",
        closeCode: PERMANENT_REJECTION_CLOSE_CODE,
        attempts: 1,
      }, testCase.name);
      assertEquals(yield* Queue.take(gateway.outcomes), {
        status: "rejected",
        closeCode: PERMANENT_REJECTION_CLOSE_CODE,
      }, testCase.name);
      assertEquals(probe.calls, { identify: 1, echo: 0, hang: 0, watch: 0 }, testCase.name);
      assertEquals(Queue.takeUnsafe(gateway.connections), undefined, testCase.name);
    })));
  }
});

Deno.test("bootstrap timeout closes with 4408 and reconnects cleanly", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
    void,
    TestError,
    Scope.Scope
  > {
    const gateway = yield* makeProofGateway();
    const blockedAuthentication = yield* Deferred.make<void>();
    yield* Queue.offer(
      gateway.policies,
      admissionPolicy({
        authenticationGate: blockedAuthentication,
        timeout: 20,
      }),
    );
    yield* Queue.offer(gateway.policies, admissionPolicy());
    const probe = yield* makeRunnerProbe(runnerIdentity());
    const runner = yield* maintainProofRunner({
      socketUrl: gateway.socketUrl,
      probe,
      maxReconnects: 1,
    }).pipe(Effect.forkScoped);

    assertEquals(yield* Queue.take(gateway.outcomes), {
      status: "timeout",
      closeCode: BOOTSTRAP_TIMEOUT_CLOSE_CODE,
    });
    assertEquals(probe.calls, { identify: 1, echo: 0, hang: 0, watch: 0 });

    const connection = yield* Queue.take(gateway.connections);
    assertEquals(yield* Queue.take(gateway.outcomes), { status: "admitted" });
    assertEquals(probe.calls.identify, 2);
    assertEquals(yield* connection.client["proof.echo"]({ value: "reconnected" }), "reconnected");

    yield* connection.close(PERMANENT_REJECTION_CLOSE_CODE, "Runner connection rejected");
    assertEquals(yield* Fiber.join(runner), {
      status: "permanent-rejection",
      closeCode: PERMANENT_REJECTION_CLOSE_CODE,
      attempts: 2,
    });
  })));
});

Deno.test("forced disconnect settles a pending RPC and permits a clean reconnect", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
    void,
    TestError,
    Scope.Scope
  > {
    const gateway = yield* makeProofGateway();
    yield* Queue.offer(gateway.policies, admissionPolicy());
    yield* Queue.offer(gateway.policies, admissionPolicy());
    const probe = yield* makeRunnerProbe(runnerIdentity());
    const runner = yield* maintainProofRunner({
      socketUrl: gateway.socketUrl,
      probe,
      maxReconnects: 1,
    }).pipe(Effect.forkScoped);

    const first = yield* Queue.take(gateway.connections);
    assertEquals(yield* Queue.take(gateway.outcomes), { status: "admitted" });
    const pending = yield* first.client["proof.hang"]().pipe(
      Effect.exit,
      Effect.forkChild,
    );
    yield* Queue.take(probe.hangStarted);
    yield* first.close(1012, "Forced disconnect");
    assert(Exit.isFailure(yield* Fiber.join(pending)));

    const second = yield* Queue.take(gateway.connections);
    assertEquals(yield* Queue.take(gateway.outcomes), { status: "admitted" });
    assertEquals(
      yield* second.client["proof.echo"]({ value: "second generation" }),
      "second generation",
    );
    yield* second.close(PERMANENT_REJECTION_CLOSE_CODE, "Runner connection rejected");

    assertEquals(yield* Fiber.join(runner), {
      status: "permanent-rejection",
      closeCode: PERMANENT_REJECTION_CLOSE_CODE,
      attempts: 2,
    });
  })));
});

Deno.test("RPC schema failures stay request-scoped and oversized frames close with 4400", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
    void,
    TestError,
    Scope.Scope
  > {
    const gateway = yield* makeProofGateway();
    yield* Queue.offer(gateway.policies, admissionPolicy());
    const probe = yield* makeRunnerProbe(runnerIdentity());
    const runner = yield* maintainProofRunner({
      socketUrl: gateway.socketUrl,
      probe,
      maxReconnects: 0,
    }).pipe(Effect.forkScoped);
    const connection = yield* Queue.take(gateway.connections);
    assertEquals(yield* Queue.take(gateway.outcomes), { status: "admitted" });

    const schemaExit = yield* connection.mismatchedClient["proof.echo"]({
      value: "wrong response schema",
    }).pipe(Effect.exit);
    assert(Exit.isFailure(schemaExit));
    const schemaDefect = Cause.findDefect(schemaExit.cause);
    assert(Result.isSuccess(schemaDefect));
    assert(Schema.isSchemaError(schemaDefect.success));
    assertEquals(
      yield* connection.client["proof.echo"]({ value: "socket remains usable" }),
      "socket remains usable",
    );

    const oversizedExit = yield* connection.client["proof.echo"]({
      value: "x".repeat(DEFAULT_PROOF_FRAME_LIMIT * 2),
    }).pipe(Effect.exit);
    assert(Exit.isFailure(oversizedExit));
    assertEquals(yield* Fiber.join(runner), {
      status: "retries-exhausted",
      closeCode: FRAME_LIMIT_CLOSE_CODE,
      attempts: 1,
    });
  })));
});

Deno.test("RPC ping timeout settles pending effects with retry disabled", async () => {
  const writes: Array<string | Uint8Array | Socket.CloseEvent> = [];
  const silentSocket = Socket.make({
    runRaw: (_handler, options) =>
      (options?.onOpen ?? Effect.void).pipe(
        Effect.andThen(Effect.never),
      ),
    writer: Effect.succeed((frame) =>
      Effect.sync(() => {
        writes.push(frame);
      })
    ),
  });

  const program = Effect.scoped(Effect.gen(function* (): Effect.fn.Return<
    void,
    TestError,
    Scope.Scope
  > {
    const protocol = yield* RpcClient.makeProtocolSocket({
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Effect.provideService(Socket.Socket, silentSocket),
      Effect.provide(RpcSerialization.layerJson),
    );
    const client = yield* RpcClient.make(ProofRunnerApi).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
    const pending = yield* client["proof.hang"]().pipe(
      Effect.exit,
      Effect.forkChild,
    );

    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    const exit = yield* Fiber.join(pending);

    assert(Exit.isFailure(exit));
    const rpcError = Cause.findError(exit.cause);
    assert(Result.isSuccess(rpcError));
    assertEquals(rpcError.success._tag, "RpcClientError");
    assertEquals(rpcError.success.reason._tag, "SocketOpenError");
    if (rpcError.success.reason._tag === "SocketOpenError") {
      assertEquals(rpcError.success.reason.kind, "Timeout");
    }
    assert(writes.some((frame) => Predicate.isString(frame) && frame.includes('"Ping"')));
  }));

  await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer({}))));
});

function runnerIdentity(
  overrides: Partial<ProofRunnerIdentity> = {},
): ProofRunnerIdentity {
  return new ProofRunnerIdentity({
    token: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    runnerVersion: RUNNER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ["rpc-proof"],
    ...overrides,
  });
}

function admissionPolicy(
  options: { readonly authenticationGate?: Deferred.Deferred<void>; readonly timeout?: number } =
    {},
): AdmissionPolicy {
  const policy = {
    expectedToken: RUNNER_TOKEN,
    expectedRunnerId: RUNNER_ID,
    expectedProtocolVersion: PROTOCOL_VERSION,
    timeout: options.timeout ?? 1_000,
  };
  return options.authenticationGate
    ? { ...policy, authenticationGate: options.authenticationGate }
    : policy;
}
