import { createAppServices } from "./app/middleware/services.ts";
import type { WorkspaceApi } from "./app/cells/workspace/api.ts";
import { workspaceEventsFrom } from "./app/cells/workspace/events.ts";
import { createAppRouter, createSessionCookie } from "./app/router.ts";
import { createGatewayAssets } from "./app/assets.ts";
import { routes } from "./app/routes.ts";
import { tryAsync } from "@openorb/result";
import type { Env } from "./app/env.ts";
import type { Request as WorkerRequest } from "@cloudflare/workers-types";

export { Workspace } from "./app/cells/workspace/workspace.ts";
export { Runners } from "./app/cells/runners/runner-registry-do.ts";
export { Session } from "./app/cells/session/session.ts";
import {
  type MediaReader,
  type SessionApi,
  sessionApiFromRpc,
  type SessionRpc,
} from "./app/cells/session/api.ts";

const ENVIRONMENT_LINK_PATH =
  /^\/api\/runners\/environments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/link$/;

const routers = new WeakMap<
  Env,
  {
    services: ReturnType<typeof createAppServices>;
    bySecureCookie: Map<boolean, ReturnType<typeof createAppRouter>>;
  }
>();

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
          // SAFETY: the runtime uses Workers Web APIs; Node and Workers declarations differ.
          // oxlint-disable-next-line openorb/no-chained-type-assertions
          return (await runners.fetch(request as unknown as WorkerRequest)) as unknown as Response;
        }
        const link = ENVIRONMENT_LINK_PATH.exec(url.pathname);
        if (link !== null) {
          // The Session Durable Object authenticates the runner in-band before relaying frames.
          const session = env.SESSIONS.getByName(link[1]!);
          // SAFETY: same Web API boundary as the runner upgrades above.
          // oxlint-disable-next-line openorb/no-chained-type-assertions
          return (await session.fetch(request as unknown as WorkerRequest)) as unknown as Response;
        }
        let cache = routers.get(env);
        if (!cache) {
          if (!env.SESSION_SECRET) {
            return new Response("Gateway is not configured", { status: 500 });
          }
          const workspaceStub = env.WORKSPACE.getByName("workspace");
          // SAFETY: native RPC implements WorkspaceApi; platform thenables differ only in checker types.
          // oxlint-disable-next-line openorb/no-chained-type-assertions
          const workspace = workspaceStub as unknown as WorkspaceApi;
          const services = createAppServices(workspace, runners, undefined, {
            assets: createGatewayAssets(env.ASSETS),
            ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}),
            sessions: (sessionId) => sessionApi(env.SESSIONS.getByName(sessionId)),
            // SAFETY: the R2 binding implements this read subset; only checker types differ.
            // oxlint-disable-next-line openorb/no-chained-type-assertions
            media: env.MEDIA as unknown as MediaReader,
            workspaceEvents: workspaceEvents(workspaceStub),
          });
          cache = { services, bySecureCookie: new Map() };
          routers.set(env, cache);
        }
        const secure =
          env.OPENORB_SESSION_COOKIE_SECURE === "true" ||
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

/** Native RPC to one Session Durable Object; its event stream uses HTTP, as celld requires. */
function sessionApi(stub: ReturnType<Env["SESSIONS"]["getByName"]>): SessionApi {
  // SAFETY: the Session class implements this native RPC surface; platform thenables differ only
  // in checker types.
  // oxlint-disable-next-line openorb/no-chained-type-assertions
  const rpc = stub as unknown as SessionRpc;
  return sessionApiFromRpc(rpc, async (original) => {
    const request = new Request("https://session.internal/events", { signal: original.signal });
    // SAFETY: native Workers Request and Response, typed by Node only for local checking.
    // oxlint-disable-next-line openorb/no-chained-type-assertions
    return (await stub.fetch(request as unknown as WorkerRequest)) as unknown as Response;
  });
}

/** The Workspace Durable Object's event stream, which uses HTTP, as celld requires. */
function workspaceEvents(stub: ReturnType<Env["WORKSPACE"]["getByName"]>) {
  return workspaceEventsFrom({
    async fetch(request) {
      // SAFETY: native Workers Request and Response, typed by Node only for local checking.
      // oxlint-disable-next-line openorb/no-chained-type-assertions
      return (await stub.fetch(request as unknown as WorkerRequest)) as unknown as Response;
    },
  });
}
