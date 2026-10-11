import {
  Connection,
  type EnvLink,
  type EnvLinkHandlers,
  RemoteExecutionEnv,
} from "@openorb/pi-env";
import type {
  EnvironmentAction,
  EnvironmentAttachAccepted,
  EnvironmentControlled,
  EnvironmentCreated,
  EnvironmentDeleted,
  EnvironmentState,
  OrbSize,
  SessionEnvironmentRecoveryMode,
  SessionEnvironmentSecret,
  WorkspaceId,
} from "@openorb/protocol/runner-api";
import { encodeBase64Url } from "@std/encoding/base64url";
import type { OperationResult } from "../../runners/runner-registry.ts";
import {
  type AgentEnvironmentProvider,
  type EnvironmentBinding,
  type EnvironmentControlResult,
  EnvironmentUnavailableError,
  type SessionEnvironment,
} from "./provider.ts";

/** The Runners Durable Object's environment procedures, as native RPC. */
export interface RunnerEnvironmentApi {
  createEnvironment(input: {
    workspaceId: WorkspaceId;
    runnerId: string;
    sessionId: string;
    payload: {
      orbSize: OrbSize;
      repositoryUrl: string;
      gitAuthor: { name: string; email: string };
    };
  }): Promise<OperationResult<EnvironmentCreated>>;
  controlEnvironment(input: {
    workspaceId: WorkspaceId;
    sessionId: string;
    payload: {
      action: EnvironmentAction;
      githubToken?: string;
      environmentSecrets?: readonly SessionEnvironmentSecret[];
      recovery?: SessionEnvironmentRecoveryMode;
    };
  }): Promise<OperationResult<EnvironmentControlled>>;
  attachEnvironment(input: {
    workspaceId: WorkspaceId;
    sessionId: string;
    nonce: string;
  }): Promise<OperationResult<EnvironmentAttachAccepted>>;
  deleteEnvironment(input: {
    workspaceId: WorkspaceId;
    sessionId: string;
  }): Promise<OperationResult<EnvironmentDeleted>>;
}

/**
 * The Session Durable Object's side of Environment Links: it accepts the runner's hibernatable
 * WebSocket and routes its messages to whichever link is current.
 */
export interface EnvironmentLinkHost {
  /** An attached link that survived hibernation, if any. */
  readonly current: () => EnvLink | undefined;
  /** Waits for the runner to dial and authenticate a link with `nonce`. */
  readonly expect: (nonce: string, signal: AbortSignal) => Promise<EnvLink>;
  /** Routes frames and closure of the current link to `handlers`. */
  readonly route: (handlers: EnvLinkHandlers | undefined) => void;
}

export interface RunnerEnvironmentState {
  readonly state: EnvironmentState;
  readonly reachable: boolean;
}

export interface RunnerProviderOptions {
  readonly runners: RunnerEnvironmentApi;
  readonly links: EnvironmentLinkHost;
  /** The last environment state the Session Durable Object recorded. */
  readonly state: () => RunnerEnvironmentState;
  readonly recordState: (state: EnvironmentState) => void;
}

/** The OpenOrb runner as an Agent Environment Provider (ADR 0006). */
export function runnerProvider(options: RunnerProviderOptions): AgentEnvironmentProvider {
  return {
    kind: "openorb-runner",
    capabilities: { persistence: "root-disk", egressSecretMediation: true, hibernatableLink: true },
    bind: (binding) => bindRunnerEnvironment(binding, options),
  };
}

function nonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function accepted<A>(result: OperationResult<A>, action: string): A {
  if (result.status === "accepted") return result.acknowledgement;
  throw new EnvironmentUnavailableError(`Could not ${action}: ${result.message}`);
}

function bindRunnerEnvironment(
  binding: EnvironmentBinding,
  options: RunnerProviderOptions,
): SessionEnvironment {
  const { workspaceId, sessionId, placement: runnerId } = binding;
  const connection = new Connection({
    open: async (handlers, signal) => {
      const existing = options.links.current();
      if (existing !== undefined) {
        options.links.route(handlers);
        return existing;
      }
      // Guest tools fail immediately while the runner is unreachable or compute is stopped.
      const { state, reachable } = options.state();
      if (!reachable) throw new EnvironmentUnavailableError("The environment's runner is offline.");
      if (state !== "running" && state !== "starting") {
        throw new EnvironmentUnavailableError(
          state === "error"
            ? "The environment failed. Restart it with the environment tool."
            : "The environment is stopped. Start it with the environment tool.",
        );
      }
      const attachNonce = nonce();
      const link = options.links.expect(attachNonce, signal);
      link.catch(() => {});
      const result = await options.runners.attachEnvironment({
        workspaceId,
        sessionId,
        nonce: attachNonce,
      });
      accepted(result, "attach the environment");
      const attached = await link;
      options.links.route(handlers);
      return attached;
    },
  });
  const env = new RemoteExecutionEnv({
    connection,
    id: `openorb:${sessionId}`,
    cwd: "/workspace",
  });
  const control = async (
    action: EnvironmentAction,
    controlOptions: Parameters<SessionEnvironment["control"]>[1] = {},
  ): Promise<EnvironmentControlResult> => {
    if (action !== "start") connection.lost("The environment is stopping.");
    const result = await options.runners.controlEnvironment({
      workspaceId,
      sessionId,
      payload: {
        action,
        ...(controlOptions.credentials?.githubToken === undefined
          ? {}
          : { githubToken: controlOptions.credentials.githubToken }),
        ...(controlOptions.credentials?.environmentSecrets === undefined
          ? {}
          : { environmentSecrets: controlOptions.credentials.environmentSecrets }),
        ...(controlOptions.recovery === undefined ? {} : { recovery: controlOptions.recovery }),
      },
    });
    const controlled = accepted(result, `${action} the environment`);
    options.recordState(controlled.state);
    return { state: controlled.state, forced: controlled.forced };
  };
  return {
    env,
    state: () => options.state().state,
    create: async (spec) => {
      const result = await options.runners.createEnvironment({
        workspaceId,
        runnerId,
        sessionId,
        payload: {
          orbSize: spec.orbSize,
          repositoryUrl: binding.repository.url,
          gitAuthor: {
            name: binding.repository.gitAuthor.name,
            email: binding.repository.gitAuthor.email,
          },
        },
      });
      options.recordState(accepted(result, "create the environment").environment.state);
    },
    control,
    delete: async () => {
      connection.close();
      accepted(
        await options.runners.deleteEnvironment({ workspaceId, sessionId }),
        "delete the environment",
      );
    },
    close: () => connection.lost("The Session Durable Object released the environment."),
  };
}
