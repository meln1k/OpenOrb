import { createAppServices } from "@/app/middleware/services.ts";
import type { WorkspaceApi } from "@/app/cells/workspace/api.ts";
import { createAppRouter, createSessionCookie } from "@/app/router.ts";
import { createGatewayAssets } from "@/app/assets.ts";
import { routes } from "@/app/routes.ts";
import { tryAsync } from "@openorb/result";
import type { Env } from "./app/env.ts";
import type { Request as WorkerRequest } from "@cloudflare/workers-types";

export { Workspace } from "@/app/cells/workspace/workspace.ts";
export { Runners } from "@/app/cells/runners/runner-registry-do.ts";

const routers = new WeakMap<Env, {
  services: ReturnType<typeof createAppServices>;
  bySecureCookie: Map<boolean, ReturnType<typeof createAppRouter>>;
}>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [response, error] = await tryAsync(
      (async () => {
        const url = new URL(request.url);
        const runners = env.RUNNERS.getByName("runners");
        if (
          url.pathname === routes.api.runners.connect.href() ||
          url.pathname === routes.api.runners.connectBulk.href()
        ) {
          // SAFETY: the runtime uses Workers Web APIs; only the checker retains Deno's API types.
          // deno-lint-ignore openorb/no-chained-type-assertions
          return await runners.fetch(request as unknown as WorkerRequest) as unknown as Response;
        }
        let cache = routers.get(env);
        if (!cache) {
          if (!env.SESSION_SECRET) {
            return new Response("Gateway is not configured", { status: 500 });
          }
          // SAFETY: native RPC implements WorkspaceApi; platform thenables differ only in checker types.
          // deno-lint-ignore openorb/no-chained-type-assertions
          const workspace = env.WORKSPACE.getByName("workspace") as unknown as WorkspaceApi;
          const services = createAppServices(workspace, runners, undefined, {
            assets: createGatewayAssets(env.ASSETS),
            ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}),
            sessionEvents: async (workspaceId, sessionId, original) => {
              const streamUrl = new URL("https://registry.internal/watch");
              streamUrl.searchParams.set("workspaceId", workspaceId);
              streamUrl.searchParams.set("sessionId", sessionId);
              const request = new Request(streamUrl, { signal: original.signal });
              // SAFETY: same Web API boundary as the upgrade above; no response reconstruction.
              // deno-lint-ignore openorb/no-chained-type-assertions
              return await runners.fetch(
                // SAFETY: native Workers Request, typed by Deno only for local checking.
                // deno-lint-ignore openorb/no-chained-type-assertions
                request as unknown as WorkerRequest,
              ) as unknown as Response;
            },
          });
          cache = { services, bySecureCookie: new Map() };
          routers.set(env, cache);
        }
        const secure = env.OPENORB_SESSION_COOKIE_SECURE === "true" ||
          new URL(env.PUBLIC_URL || request.url).protocol === "https:";
        let router = cache.bySecureCookie.get(secure);
        if (!router) {
          router = createAppRouter(
            cache.services,
            createSessionCookie({
              secret: env.SESSION_SECRET,
              secure,
            }),
          );
          cache.bySecureCookie.set(secure, router);
        }
        return await router.fetch(request);
      })(),
      () => "failed",
    );
    // Provider credentials and transport errors must never enter browser error responses.
    if (error !== undefined) return new Response("Gateway operation failed", { status: 500 });
    return response;
  },
};
