import { runnerEnrollmentResponseSchema } from "@openorb/protocol";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";
import { object, parse, string } from "@remix-run/data-schema";

import { normalizeGatewayUrl } from "./options.ts";

const METADATA_FILE = "runner.json";
const TOKEN_FILE = "token";

export interface RunnerIdentity {
  runnerId: string;
  runnerToken: string;
  gatewayUrl: string;
}

interface RunnerMetadata {
  runnerId: string;
  gatewayUrl: string;
}

const runnerMetadataSchema = object(
  {
    runnerId: string(),
    gatewayUrl: string(),
  },
  { unknownKeys: "error" },
);

export async function readRunnerIdentity(
  directory: string,
): Promise<Result<RunnerIdentity | null, RunnerIdentityReadError>> {
  const metadataPath = `${directory}/${METADATA_FILE}`;
  const tokenPath = `${directory}/${TOKEN_FILE}`;
  const pendingMetadataExistence = exists(metadataPath);
  const pendingTokenExistence = exists(tokenPath);
  const [metadataExists, metadataExistenceError] = await pendingMetadataExistence;
  if (metadataExistenceError !== undefined) return err(metadataExistenceError);
  const [tokenExists, tokenExistenceError] = await pendingTokenExistence;
  if (tokenExistenceError !== undefined) return err(tokenExistenceError);
  if (!metadataExists && !tokenExists) return ok(null);
  if (!metadataExists || !tokenExists) {
    return err(
      new RunnerIdentityReadError(
        "Runner identity is incomplete; runner.json and token must both exist.",
        undefined,
      ),
    );
  }

  const [tokenInfo, tokenInspectionError] = await tryAsync(
    Deno.lstat(tokenPath),
    (cause) =>
      new RunnerIdentityReadError(
        `Runner identity could not be read: ${errorMessage(cause)}`,
        cause,
      ),
  );
  if (tokenInspectionError !== undefined) return err(tokenInspectionError);
  if (!tokenInfo.isFile || tokenInfo.isSymlink) {
    return err(new RunnerIdentityReadError("Runner token must be a regular file.", undefined));
  }
  if (
    Deno.build.os !== "windows" && tokenInfo.mode !== null &&
    (tokenInfo.mode & 0o777) !== 0o600
  ) {
    return err(new RunnerIdentityReadError("Runner token permissions must be 0600.", undefined));
  }

  return await tryAsync(
    (async () => {
      const metadata = parse(
        runnerMetadataSchema,
        JSON.parse(await Deno.readTextFile(metadataPath)),
      );
      const runnerToken = await Deno.readTextFile(tokenPath);
      parse(runnerEnrollmentResponseSchema, { runnerId: metadata.runnerId, runnerToken });

      return {
        runnerId: metadata.runnerId,
        runnerToken,
        gatewayUrl: normalizeGatewayUrl(metadata.gatewayUrl),
      };
    })(),
    (cause) =>
      new RunnerIdentityReadError(
        `Runner identity could not be read: ${errorMessage(cause)}`,
        cause,
      ),
  );
}

export async function writeRunnerIdentity(
  directory: string,
  identity: RunnerIdentity,
): Promise<Result<void, RunnerIdentityWriteError>> {
  const [metadata, validationError] = trySync(
    (): RunnerMetadata => {
      parse(runnerEnrollmentResponseSchema, {
        runnerId: identity.runnerId,
        runnerToken: identity.runnerToken,
      });
      return {
        runnerId: identity.runnerId,
        gatewayUrl: normalizeGatewayUrl(identity.gatewayUrl),
      };
    },
    (cause) => new RunnerIdentityWriteError("Runner identity is invalid.", cause),
  );
  if (validationError !== undefined) return err(validationError);

  const [, metadataWriteError] = await writePrivateFile(
    `${directory}/${METADATA_FILE}`,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  if (metadataWriteError !== undefined) return err(metadataWriteError);
  return await writePrivateFile(`${directory}/${TOKEN_FILE}`, identity.runnerToken);
}

async function writePrivateFile(
  path: string,
  contents: string,
): Promise<Result<void, RunnerIdentityWriteError>> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const [value, writeError] = await tryAsync(
    (async () => {
      await Deno.writeTextFile(temporaryPath, contents, { createNew: true, mode: 0o600 });
      if (Deno.build.os !== "windows") await Deno.chmod(temporaryPath, 0o600);
      await Deno.rename(temporaryPath, path);
    })(),
    (cause) => new RunnerIdentityWriteError("Runner identity could not be persisted.", cause),
  );
  if (writeError !== undefined) {
    const [, cleanupError] = await tryAsync(Deno.remove(temporaryPath), () => false);
    if (cleanupError !== undefined) return err(writeError);
    return err(writeError);
  }
  return ok(value);
}

async function exists(path: string): Promise<Result<boolean, RunnerIdentityReadError>> {
  const [, inspectionError] = await tryAsync(
    Deno.lstat(path),
    (cause) => new RunnerIdentityReadError("Runner identity files could not be inspected.", cause),
  );
  if (inspectionError !== undefined) {
    if (inspectionError.cause instanceof Deno.errors.NotFound) return ok(false);
    return err(inspectionError);
  }
  return ok(true);
}

export class RunnerIdentityReadError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "RunnerIdentityReadError";
  }
}

export class RunnerIdentityWriteError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "RunnerIdentityWriteError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
