import {
  decodeWorkspaceArguments,
  WORKSPACE_OPERATIONS,
  type WorkspaceApi,
  type WorkspaceOperation,
} from "./api.ts";
import type { Env } from "./env.ts";

export { Workspace } from "./workspace.ts";

type WorkspaceStub = ReturnType<Env["WORKSPACE"]["getByName"]>;

function prepareRpc(
  workspace: WorkspaceStub,
  operation: WorkspaceOperation,
  input: unknown,
): () => ReturnType<WorkspaceStub[WorkspaceOperation]> {
  if (operation === "reconcileSessionManifestEntries") {
    const [workspaceId, entries] = decodeWorkspaceArguments(operation, input);
    // Validate the full manifest, but only send plain catalog fields across native RPC.
    const catalog = entries.map(({ id, projectId, createdAt, initialPromptPreview }) => ({
      id,
      projectId,
      createdAt,
      initialPromptPreview,
    }));
    return () => workspace.reconcileSessionManifestEntries(workspaceId, catalog);
  }
  const args = decodeWorkspaceArguments(operation, input);
  // SAFETY: These RPC methods share their argument tuples with WorkspaceApi; the schema map
  // checks those tuples. TypeScript loses the key/argument correlation on indexed invocation.
  const method = workspace[operation] as (
    ...args: Readonly<Parameters<WorkspaceApi[typeof operation]>>
  ) => ReturnType<WorkspaceStub[typeof operation]>;
  return () => method.call(workspace, ...args);
}

export default {
  // Deliberately unauthenticated during migration: bind celld to loopback, never expose this Worker.
  async fetch(request: Request, environment: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") {
      try {
        await environment.WORKSPACE.getByName("workspace").health();
        return Response.json({ status: "ok" });
      } catch {
        return new Response("Workspace unavailable", { status: 503 });
      }
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const operation = WORKSPACE_OPERATIONS.find((name) => name === path.slice(1));
    if (!operation) return new Response("Not found", { status: 404 });
    if (Number(request.headers.get("content-length")) > 16 * 1024 * 1024) {
      return new Response("Request too large", { status: 413 });
    }
    let invoke: ReturnType<typeof prepareRpc>;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).length > 16 * 1024 * 1024) {
        return new Response("Request too large", { status: 413 });
      }
      invoke = prepareRpc(
        environment.WORKSPACE.getByName("workspace"),
        operation,
        JSON.parse(body),
      );
    } catch {
      return new Response("Invalid request", { status: 400 });
    }
    try {
      const value = await invoke();
      return Response.json(value ?? null, { headers: { "cache-control": "no-store" } });
    } catch {
      // Never return ciphertext, provider bodies, tokens, or raw exception causes.
      return new Response("Workspace operation failed", { status: 500 });
    }
  },
};
