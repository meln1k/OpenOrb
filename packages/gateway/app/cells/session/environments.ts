import {
  type EnvironmentProviders,
  type RunnerEnvironmentApi,
  runnerProvider,
  sandboxProvider,
} from "@openorb/environments";
import type { Env } from "../../env.ts";
import type { WorkspaceApi } from "../workspace/api.ts";

/**
 * The Agent Environment Providers this gateway offers, by placement provider name. A Session
 * opens the one its placement names and depends on nothing else about it.
 */
export function environmentProviders(
  env: Env,
  workspace: Pick<WorkspaceApi, "authenticateRunner">,
): EnvironmentProviders {
  return {
    runner: runnerProvider({
      // SAFETY: native RPC stubs implement this interface; platform thenables differ only in types.
      // oxlint-disable-next-line openorb/no-chained-type-assertions
      runners: env.RUNNERS.getByName("runners") as unknown as RunnerEnvironmentApi,
      authenticate: (token) => workspace.authenticateRunner(token),
    }),
    sandbox: sandboxProvider({ loader: env.LOADER }),
  };
}
