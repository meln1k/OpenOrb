import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { LinkConnection } from "@openorb/pi-env";
import {
  type EnvironmentAction,
  type EnvironmentControlled,
  type EnvironmentCreated,
  type EnvironmentDeleted,
  EnvironmentState,
  type OrbSize,
  type SessionEnvironmentSecret,
  type WorkspaceId,
} from "@openorb/protocol/runner-api";
import { Schema } from "effect";
import {
  type Environment,
  type EnvironmentControlResult,
  type EnvironmentHost,
  type EnvironmentProvider,
  EnvironmentUnavailableError,
} from "../environment.ts";
import { EnvironmentLinks, type LinkAuthority } from "./link.ts";

export type OperationResult<A> =
  | { status: "accepted"; acknowledgement: A }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "delivery-uncertain"; message: string };

/** Which environment a call addresses: the runner a Session's placement names. */
interface EnvironmentAddress {
  workspaceId: WorkspaceId;
  runnerId: string;
  sessionId: string;
}

/** The Runners Durable Object's environment procedures, as native RPC. */
export interface RunnerEnvironmentApi {
  createEnvironment(
    input: EnvironmentAddress & {
      payload: {
        orbSize: OrbSize;
        repository?: { url: string; gitAuthor: { name: string; email: string } };
      };
    },
  ): Promise<OperationResult<EnvironmentCreated>>;
  controlEnvironment(
    input: EnvironmentAddress & {
      payload: {
        action: EnvironmentAction;
        githubToken?: string;
        environmentSecrets?: readonly SessionEnvironmentSecret[];
      };
    },
  ): Promise<OperationResult<EnvironmentControlled>>;
  deleteEnvironment(input: EnvironmentAddress): Promise<OperationResult<EnvironmentDeleted>>;
}

/** What the Runners Durable Object reports about a runner environment (ADR 0006). */
const RunnerNotice = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("changed"),
    runnerId: Schema.String,
    state: EnvironmentState,
  }),
  Schema.Struct({
    type: Schema.Literals(["unreachable", "revoked"]),
    runnerId: Schema.String,
  }),
]);

export interface RunnerProviderOptions {
  readonly runners: RunnerEnvironmentApi;
  /** Resolves a runner token to its runner, for Environment Link authentication. */
  readonly authenticate: LinkAuthority["authenticate"];
}

/**
 * The OpenOrb runner as an Agent Environment Provider (ADR 0006). Its placement names the runner
 * that owns the Session's Persistent Root Disk.
 */
export function runnerProvider(options: RunnerProviderOptions): EnvironmentProvider {
  return {
    capabilities: { credentials: "mediated", git: true },
    guestPrompt: [],
    open: (host) => openRunnerEnvironment(host, options),
  };
}

function accepted<A>(result: OperationResult<A>, action: string): A {
  if (result.status === "accepted") return result.acknowledgement;
  throw new EnvironmentUnavailableError(`Could not ${action}: ${result.message}`);
}

function openRunnerEnvironment(
  host: EnvironmentHost,
  { runners, authenticate }: RunnerProviderOptions,
): Environment {
  const { workspaceId, sessionId } = host;
  const runnerId = Schema.decodeUnknownSync(Schema.String)(host.placement.runnerId);
  const address = { workspaceId, runnerId, sessionId };
  const links = new EnvironmentLinks(host, { runnerId, workspaceId, authenticate });
  // Link liveness answered by the platform, so an idle link never wakes the Session.
  host.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
  const report = (state: EnvironmentState) => host.report({ state, reachable: true });
  const connection = new LinkConnection({
    open: async (handlers, signal) => {
      // Without a link, guest tools fail immediately while the runner is unreachable or compute
      // is stopped; running compute has its runner dial the link.
      const { state, reachable } = host.status();
      if (links.current() === undefined) {
        if (!reachable) {
          throw new EnvironmentUnavailableError("The environment's runner is offline.");
        }
        if (state !== "running" && state !== "starting") {
          throw new EnvironmentUnavailableError(
            state === "error"
              ? "The environment failed. Restart it with the environment tool."
              : "The environment is stopped. Start it with the environment tool.",
          );
        }
      }
      const link = await links.next(signal);
      links.route(handlers);
      return link;
    },
  });
  return {
    env: new RemoteExecutionEnv({ connection, id: `openorb:${sessionId}`, cwd: "/workspace" }),
    create: async (spec) => {
      const result = await runners.createEnvironment({
        ...address,
        payload: {
          orbSize: spec.orbSize,
          ...(host.repository === undefined
            ? {}
            : {
                repository: {
                  url: host.repository.url,
                  gitAuthor: {
                    name: host.repository.gitAuthor.name,
                    email: host.repository.gitAuthor.email,
                  },
                },
              }),
        },
      });
      report(accepted(result, "create the environment").environment.state);
    },
    control: async (action, { credentials } = {}): Promise<EnvironmentControlResult> => {
      if (action !== "start") connection.lost("The environment is stopping.");
      const result = await runners.controlEnvironment({
        ...address,
        payload: {
          action,
          ...(credentials?.githubToken === undefined
            ? {}
            : { githubToken: credentials.githubToken }),
          ...(credentials?.environmentSecrets === undefined
            ? {}
            : { environmentSecrets: credentials.environmentSecrets }),
        },
      });
      const controlled = accepted(result, `${action} the environment`);
      report(controlled.state);
      return { state: controlled.state, forced: controlled.forced };
    },
    delete: async () => {
      connection.close();
      accepted(await runners.deleteEnvironment(address), "delete the environment");
      links.closeAll(1000, "The session was deleted.");
    },
    // The link outlives agent activity: losing it would kill the processes the daemon started.
    release: () => {},
    fetch: (request) => links.accept(request),
    webSocketMessage: (socket, message) => links.message(socket, message),
    webSocketClose: (socket, reason) => links.closed(socket, reason),
    notice: (value) => {
      const notice = Schema.decodeUnknownSync(RunnerNotice)(value);
      if (notice.runnerId !== runnerId) return;
      switch (notice.type) {
        case "changed":
          host.report({ state: notice.state, reachable: true });
          if (notice.state !== "running" && notice.state !== "starting") {
            links.closeAll(1000, "The environment is no longer running.");
          }
          return;
        case "unreachable":
          // The link is independent of the control connection and may still be healthy.
          host.report({ ...host.status(), reachable: false });
          return;
        case "revoked":
          host.report({ ...host.status(), reachable: false });
          links.closeAll(4401, "The runner was revoked.");
      }
    },
  };
}
