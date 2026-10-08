import type { WorkspaceApi, WorkspaceOperation } from "./api.ts";
import { Schema } from "effect";
import { SessionEnvironmentSecrets } from "@openorb/protocol/runner-api";

export class WorkspaceClient {
  constructor(
    private readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async call<K extends WorkspaceOperation>(
    operation: K,
    ...args: Parameters<WorkspaceApi[K]>
  ): Promise<Awaited<ReturnType<WorkspaceApi[K]>>> {
    const body = JSON.stringify(
      args.slice(0, args.findLastIndex((value) => value !== undefined) + 1),
    );
    // Mutations are never retried: a lost response can follow a successful commit.
    const response = await this.fetcher(new URL(operation, `${this.url.replace(/\/$/, "")}/`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Workspace operation failed (${response.status}).`);
    const result = await response.json();
    if (
      [
        "createAdministrator",
        "deleteProject",
        "getEnvironmentSecrets",
        "getModelProviderApiKey",
        "getGitHubToken",
        "deleteSessionCatalogEntry",
        "reconcileSessionManifestEntries",
      ].includes(operation)
    ) {
      result[1] = result[1] == null
        ? undefined
        : new Error("Workspace persistence operation failed.");
    }
    if (operation === "getEnvironmentSecrets" && result[1] === undefined) {
      result[0] = Schema.decodeUnknownSync(SessionEnvironmentSecrets)(result[0]);
    }
    if (
      operation === "getRunnerEnrollmentToken" || operation === "regenerateRunnerEnrollmentToken"
    ) {
      result.createdAt = Temporal.Instant.from(result.createdAt);
    }
    if (operation === "listRunners") {
      for (const runner of result) {
        runner.createdAt = Temporal.Instant.from(runner.createdAt);
        runner.revokedAt = runner.revokedAt === null
          ? null
          : Temporal.Instant.from(runner.revokedAt);
      }
    }
    return result;
  }
}
