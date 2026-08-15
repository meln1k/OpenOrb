import { runnerEnrollmentResponseSchema } from "@openorb/protocol";
import { object, parse, string } from "@remix-run/data-schema";

import { normalizeControlPanelUrl } from "./options.ts";

const METADATA_FILE = "runner.json";
const TOKEN_FILE = "token";

export interface RunnerIdentity {
  runnerId: string;
  runnerToken: string;
  controlPanelUrl: string;
}

interface RunnerMetadata {
  runnerId: string;
  controlPanelUrl: string;
}

const runnerMetadataSchema = object(
  {
    runnerId: string(),
    controlPanelUrl: string(),
  },
  { unknownKeys: "error" },
);

export async function readRunnerIdentity(directory: string): Promise<RunnerIdentity | null> {
  const metadataPath = `${directory}/${METADATA_FILE}`;
  const tokenPath = `${directory}/${TOKEN_FILE}`;
  const [metadataExists, tokenExists] = await Promise.all([
    exists(metadataPath),
    exists(tokenPath),
  ]);
  if (!metadataExists && !tokenExists) return null;
  if (!metadataExists || !tokenExists) {
    throw new Error("Runner identity is incomplete; runner.json and token must both exist.");
  }

  const tokenInfo = await Deno.lstat(tokenPath);
  if (!tokenInfo.isFile || tokenInfo.isSymlink) {
    throw new Error("Runner token must be a regular file.");
  }
  if (
    Deno.build.os !== "windows" && tokenInfo.mode !== null && (tokenInfo.mode & 0o777) !== 0o600
  ) {
    throw new Error("Runner token permissions must be 0600.");
  }

  let metadata: RunnerMetadata;
  try {
    const value: unknown = JSON.parse(await Deno.readTextFile(metadataPath));
    metadata = parse(runnerMetadataSchema, value);
  } catch {
    throw new Error("Runner metadata is invalid.");
  }
  const runnerToken = await Deno.readTextFile(tokenPath);
  parse(runnerEnrollmentResponseSchema, { runnerId: metadata.runnerId, runnerToken });

  return {
    runnerId: metadata.runnerId,
    runnerToken,
    controlPanelUrl: normalizeControlPanelUrl(metadata.controlPanelUrl),
  };
}

export async function writeRunnerIdentity(
  directory: string,
  identity: RunnerIdentity,
): Promise<void> {
  parse(runnerEnrollmentResponseSchema, {
    runnerId: identity.runnerId,
    runnerToken: identity.runnerToken,
  });
  const metadata: RunnerMetadata = {
    runnerId: identity.runnerId,
    controlPanelUrl: normalizeControlPanelUrl(identity.controlPanelUrl),
  };

  await writePrivateFile(`${directory}/${METADATA_FILE}`, `${JSON.stringify(metadata, null, 2)}\n`);
  await writePrivateFile(`${directory}/${TOKEN_FILE}`, identity.runnerToken);
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporaryPath, contents, { createNew: true, mode: 0o600 });
    if (Deno.build.os !== "windows") await Deno.chmod(temporaryPath, 0o600);
    await Deno.rename(temporaryPath, path);
  } catch (error) {
    await Deno.remove(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
