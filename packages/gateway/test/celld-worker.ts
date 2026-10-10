import gateway from "../server.ts";
import workspaceDriver from "./workspace/http-worker.ts";
import type { Env } from "../app/env.ts";
import { Schema } from "effect";
import { WorkspaceId } from "@openorb/protocol/runner-api";
import type { Request as WorkerRequest } from "@cloudflare/workers-types";

export { Workspace } from "./workspace/celld-worker.ts";
export { Runners } from "../app/cells/runners/runner-registry-do.ts";

const sessionInput = Schema.Struct({ workspaceId: WorkspaceId, sessionId: Schema.String });
const artifactInput = Schema.Struct({
  workspaceId: WorkspaceId,
  sessionId: Schema.String,
  artifactId: Schema.String,
  offset: Schema.Number,
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
    if (url.pathname === "/__registry/snapshot") {
      const id = Schema.decodeUnknownSync(WorkspaceId)(url.searchParams.get("workspaceId"));
      return Response.json(
        await env.RUNNERS.getByName("runners").getSessionSnapshot(
          id,
          url.searchParams.get("sessionId")!,
        ),
      );
    }
    if (url.pathname === "/__registry/stop" && request.method === "POST") {
      const input = Schema.decodeUnknownSync(sessionInput)(await request.json());
      return Response.json(await env.RUNNERS.getByName("runners").stopSession(input));
    }
    if (url.pathname === "/__registry/disconnect" && request.method === "POST") {
      const input = Schema.decodeUnknownSync(Schema.Struct({
        workspaceId: WorkspaceId,
        runnerId: Schema.String,
      }))(await request.json());
      return Response.json(
        await env.RUNNERS.getByName("runners").disconnectRunner(input.workspaceId, input.runnerId),
      );
    }
    if (url.pathname === "/__registry/artifact" && request.method === "POST") {
      const input = Schema.decodeUnknownSync(artifactInput)(await request.json());
      const result = await env.RUNNERS.getByName("runners").readSessionArtifactChunk(input);
      if (result.status !== "accepted") return Response.json(result, { status: 409 });
      const chunk = result.acknowledgement;
      // Check on the Worker side of native RPC, before HTTP can hide a lost binary type.
      if (!(chunk.bytes instanceof Uint8Array)) {
        return new Response("Native RPC lost Uint8Array", { status: 500 });
      }
      return new Response(new Uint8Array(chunk.bytes), {
        headers: {
          "content-type": "application/octet-stream",
          "x-native-byte-type": "Uint8Array",
          "x-artifact-offset": String(chunk.offset),
          "x-artifact-id": chunk.artifact.id,
          "x-artifact-byte-length": String(chunk.artifact.byteLength),
        },
      });
    }
    if (url.pathname === "/__registry/watch") {
      url.pathname = "/watch";
      // SAFETY: celld uses Workers Web APIs; Deno's checker has different Request/Response types.
      // deno-lint-ignore openorb/no-chained-type-assertions
      const streamRequest = new Request(url, request) as unknown as WorkerRequest;
      // SAFETY: return the native response unchanged, preserving stream cancellation.
      // deno-lint-ignore openorb/no-chained-type-assertions
      return await env.RUNNERS.getByName("runners").fetch(streamRequest) as unknown as Response;
    }
    return gateway.fetch(request, env);
  },
};
