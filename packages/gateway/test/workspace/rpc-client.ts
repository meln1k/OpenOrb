import { WORKSPACE_OPERATIONS, type WorkspaceApi } from "../../app/cells/workspace/api.ts";

/** Test driver across the Deno/celld boundary; the production Worker uses native stubs directly. */
export function createRpcClient(url: string): WorkspaceApi {
  // SAFETY: the closed operation list supplies every named WorkspaceApi method below.
  return new Proxy({} as WorkspaceApi, {
    get(_target, name) {
      if (!WORKSPACE_OPERATIONS.some((operation) => operation === name)) return undefined;
      return async (...args: unknown[]) => {
        // JSON has no undefined; optional trailing arguments must be omitted, never made null.
        while (args.length > 0 && args.at(-1) === undefined) args.pop();
        const response = await fetch(new URL(String(name), `${url}/`), {
          method: "POST",
          body: JSON.stringify(args),
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) throw new Error("Workspace operation failed");
        const value = await response.json();
        // Only this HTTP fixture decodes JSON's null placeholders in native Result tuples.
        if (
          [
            "createAdministrator",
            "deleteProject",
            "getEnvironmentSecrets",
            "getModelProviderApiKey",
            "getGitHubToken",
            "deleteSessionCatalogEntry",
            "reconcileSessionManifestEntries",
          ].includes(String(name))
        ) {
          if (value[1] === null) value[1] = undefined;
          else {
            value[0] = undefined;
            value[1] = new Error("Workspace persistence operation failed.");
          }
        }
        if (["health", "cancelProviderLogin", "deleteBrowserSessions"].includes(String(name))) {
          return undefined;
        }
        return value;
      };
    },
  });
}
