import gateway from "../server.ts";
import workspaceDriver from "./workspace/http-worker.ts";
import type { Env } from "../app/env.ts";
import { Schema } from "effect";
import { EnvironmentAction, WorkspaceId } from "@openorb/protocol/runner-api";
import type { Request as WorkerRequest } from "@cloudflare/workers-types";
import { createAgentModels } from "../app/cells/session/agent.ts";

export { Workspace } from "./workspace/celld-worker.ts";
export { Runners } from "../app/cells/runners/runner-registry-do.ts";
// The SESSIONS binding resolves this class by name; the fixture scripts its model.
export { ScriptedSession as Session } from "./session-fixture.ts";

const environmentInput = Schema.Struct({
  workspaceId: WorkspaceId,
  sessionId: Schema.String,
  action: EnvironmentAction,
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__codex-auth") {
      const models = createAgentModels({
        read: () =>
          Promise.resolve({
            type: "oauth",
            access: "fixture-access-token",
            refresh: "",
            expires: Date.now() + 6 * 60_000,
          }),
        list: () => Promise.resolve([]),
        modify: () => Promise.reject(new Error("Workspace owns refresh")),
        delete: () => Promise.resolve(),
      });
      return Response.json(await models.getAuth("openai-codex"));
    }
    if (url.pathname.startsWith("/__https/")) {
      url.protocol = "https:";
      url.pathname = url.pathname.slice("/__https".length);
      return gateway.fetch(new Request(url, request), env);
    }
    if (url.pathname.startsWith("/__workspace/")) {
      url.pathname = url.pathname.slice("/__workspace".length);
      return workspaceDriver.fetch(new Request(url, request), env);
    }
    if (url.pathname === "/__registry/live") {
      const id = Schema.decodeUnknownSync(WorkspaceId)(url.searchParams.get("workspaceId"));
      const runner = url.searchParams.get("runnerId")!;
      return Response.json(await env.RUNNERS.getByName("runners").getRunnerLiveState(id, runner));
    }
    // Disposable fixture only: explicit native RPC probes, never a production HTTP API.
    if (url.pathname === "/__registry/environment") {
      const id = Schema.decodeUnknownSync(WorkspaceId)(url.searchParams.get("workspaceId"));
      return Response.json(
        await env.RUNNERS.getByName("runners").getEnvironment(
          id,
          url.searchParams.get("sessionId")!,
        ),
      );
    }
    if (url.pathname === "/__registry/environment/control" && request.method === "POST") {
      const input = Schema.decodeUnknownSync(environmentInput)(await request.json());
      return Response.json(
        await env.RUNNERS.getByName("runners").controlEnvironment({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          payload: { action: input.action },
        }),
      );
    }
    if (url.pathname === "/__registry/disconnect" && request.method === "POST") {
      const input = Schema.decodeUnknownSync(
        Schema.Struct({
          workspaceId: WorkspaceId,
          runnerId: Schema.String,
        }),
      )(await request.json());
      return Response.json(
        await env.RUNNERS.getByName("runners").disconnectRunner(input.workspaceId, input.runnerId),
      );
    }
    // Disposable fixture only: Session Durable Object probes for the phase 1 end-to-end test.
    if (url.pathname === "/__session/create" && request.method === "POST") {
      const input = await request.json();
      const session = env.SESSIONS.getByName(String(input.sessionId));
      return Response.json(await session.create(input));
    }
    if (url.pathname === "/__sandbox-reload-probe" && request.method === "POST") {
      // SAFETY: only the disposable ScriptedSession fixture exposes this probe.
      // oxlint-disable-next-line openorb/no-chained-type-assertions
      const session = env.SESSIONS.getByName(crypto.randomUUID()) as unknown as {
        sandboxReloadProbe(): Promise<{ cycles: number; retained: number }>;
      };
      return Response.json(await session.sandboxReloadProbe());
    }
    if (url.pathname === "/__session/control" && request.method === "POST") {
      const input = await request.json();
      const session = env.SESSIONS.getByName(String(input.sessionId));
      return Response.json(await session.controlEnvironment(input.action));
    }
    if (url.pathname === "/__session/submit" && request.method === "POST") {
      const input = await request.json();
      const session = env.SESSIONS.getByName(String(input.sessionId));
      return Response.json(
        await session.submit({ prompt: input.prompt, requestId: input.requestId }),
      );
    }
    if (url.pathname === "/__workspace-credential-reads") {
      // SAFETY: the fixture's Workspace subclass adds this disposable probe.
      // oxlint-disable-next-line openorb/no-chained-type-assertions
      const workspace = env.WORKSPACE.getByName("workspace") as unknown as {
        credentialReads(): Promise<number>;
      };
      return Response.json(await workspace.credentialReads());
    }
    if (url.pathname === "/__session/view") {
      const session = env.SESSIONS.getByName(url.searchParams.get("sessionId")!);
      return Response.json(await session.view());
    }
    if (url.pathname === "/__session/git") {
      const session = env.SESSIONS.getByName(url.searchParams.get("sessionId")!);
      return Response.json(await session.gitSnapshot());
    }
    if (url.pathname === "/__session/media") {
      const session = env.SESSIONS.getByName(url.searchParams.get("sessionId")!);
      const media = await session.media(url.searchParams.get("id")!);
      if (media === null) return new Response("Media not found.", { status: 404 });
      if (media.kind === "inline") return new Response(new Uint8Array(media.bytes));
      const object = await env.MEDIA.get(media.key);
      if (object === null) return new Response("Media object missing.", { status: 404 });
      return new Response(new Uint8Array(await object.arrayBuffer()), {
        headers: { "content-type": media.mediaType },
      });
    }
    if (url.pathname === "/__session/events") {
      const session = env.SESSIONS.getByName(url.searchParams.get("sessionId")!);
      // SAFETY: celld uses Workers Web APIs; Node's checker has different Request/Response types.
      // oxlint-disable-next-line openorb/no-chained-type-assertions
      const eventsRequest = new Request(
        "https://session.internal/events",
        request,
      ) as unknown as WorkerRequest;
      // SAFETY: return the native streaming response unchanged.
      // oxlint-disable-next-line openorb/no-chained-type-assertions
      return (await session.fetch(eventsRequest)) as unknown as Response;
    }
    return gateway.fetch(request, env);
  },
};
