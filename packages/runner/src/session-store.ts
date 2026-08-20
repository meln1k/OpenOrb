import {
  initialPromptPreview,
  modelReferenceSchema,
  projectIdSchema,
  type RunnerCheckoutState,
  runnerCheckoutStateSchema,
  runnerIdSchema,
  runnerSessionCreatedAtSchema,
  type RunnerSessionSnapshot,
  type RunnerSessionState,
  runnerSessionStateSchema,
  sessionBranchNameSchema,
  sessionGitRefSchema,
  sessionIdSchema,
  sessionRepositoryUrlSchema,
} from "@openorb/protocol";
import { type InferOutput, literal, object, optional, parse, string } from "@remix-run/data-schema";
import { dirname, join } from "node:path";
import { type Result, tryAsync } from "@openorb/result";

import { readPiSessionEvents } from "@/src/pi-session-history.ts";

const SESSIONS_DIRECTORY = "sessions";
const METADATA_FILE = "metadata.json";
const PI_SESSION_FILE = join("pi", "session.jsonl");

const metadataSchema = object(
  {
    version: literal(1 as const),
    id: sessionIdSchema,
    projectId: projectIdSchema,
    runnerId: runnerIdSchema,
    createdAt: runnerSessionCreatedAtSchema,
    repositoryUrl: sessionRepositoryUrlSchema,
    ref: sessionGitRefSchema,
    branchName: sessionBranchNameSchema,
    initialPrompt: string().refine(
      (value) => initialPromptPreview(value).length > 0,
      "The initial prompt must contain non-whitespace text.",
    ),
    model: modelReferenceSchema,
    state: runnerSessionStateSchema,
    checkoutState: runnerCheckoutStateSchema,
    baseCommit: optional(
      string().refine(
        (value) => /^[0-9a-f]{40,64}$/.test(value),
        "Base commits must be hexadecimal object identifiers.",
      ),
    ),
  },
  { unknownKeys: "error" },
);

export type RunnerSessionMetadata = InferOutput<typeof metadataSchema>;

export interface CreateRunnerSessionInput {
  id: string;
  projectId: string;
  repositoryUrl: string;
  ref: string;
  branchName: string;
  initialPrompt: string;
  model: string;
  createdAt?: string;
}

export interface RunnerSessionPiPaths {
  agentDirectory: string;
  sessionFile: string;
}

export interface UpdateRunnerSessionProvisioningInput {
  state: RunnerSessionState;
  checkoutState: RunnerCheckoutState;
  baseCommit?: string;
}

export interface RunnerSessionInventoryError {
  sessionDirectory: string;
  message: string;
}

export interface RunnerSessionInventory {
  sessions: RunnerSessionSnapshot[];
  errors: RunnerSessionInventoryError[];
}

export type RunnerSessionStoreOperation =
  | "initialize"
  | "create-session"
  | "read-metadata"
  | "update-session-state"
  | "update-provisioning"
  | "get-workspace-path"
  | "get-pi-paths"
  | "get-session-snapshot"
  | "load-inventory";

export class RunnerSessionStoreError extends Error {
  constructor(
    readonly operation: RunnerSessionStoreOperation,
    message: string,
    override readonly cause: unknown,
  ) {
    super(message, { cause });
    this.name = "RunnerSessionStoreError";
  }
}

export class RunnerSessionStore {
  readonly #workingDirectory: string;
  readonly #runnerId: string;

  constructor(options: { workingDirectory: string; runnerId: string }) {
    this.#workingDirectory = options.workingDirectory;
    this.#runnerId = parse(runnerIdSchema, options.runnerId);
  }

  initialize(): Promise<Result<void, RunnerSessionStoreError>> {
    return tryAsync(
      ensurePrivateDirectory(this.sessionsPath()),
      storeError("initialize", "Could not initialize runner session storage"),
    );
  }

  createSession(
    input: CreateRunnerSessionInput,
  ): Promise<Result<RunnerSessionMetadata, RunnerSessionStoreError>> {
    return tryAsync(
      this.#createSession(input),
      storeError("create-session", `Could not create runner session ${input.id}`),
    );
  }

  async #createSession(input: CreateRunnerSessionInput): Promise<RunnerSessionMetadata> {
    const metadata = parseMetadata({
      version: 1,
      id: input.id,
      projectId: input.projectId,
      runnerId: this.#runnerId,
      createdAt: input.createdAt ?? Temporal.Now.instant().toString(),
      repositoryUrl: input.repositoryUrl,
      ref: input.ref,
      branchName: input.branchName,
      initialPrompt: input.initialPrompt,
      model: input.model,
      state: "created",
      checkoutState: "pending",
    });

    await ensurePrivateDirectory(this.sessionsPath());
    const sessionPath = this.sessionPath(metadata.id);
    await Deno.mkdir(sessionPath, { mode: 0o700 });
    let committed = false;
    await using rollback = new AsyncDisposableStack();
    rollback.defer(async () => {
      if (committed) return;
      await tryAsync(Deno.remove(sessionPath, { recursive: true }), () => undefined);
    });

    for (const directory of ["workspace", "pi", "logs", "reports"]) {
      await Deno.mkdir(join(sessionPath, directory), { mode: 0o700 });
    }
    await Deno.mkdir(join(sessionPath, "pi", "agent"), { mode: 0o700 });
    await writeNewPrivateFile(join(sessionPath, PI_SESSION_FILE), new Uint8Array());
    await writeAtomicMetadata(join(sessionPath, METADATA_FILE), metadata);
    await syncDirectory(this.sessionsPath());
    committed = true;
    return metadata;
  }

  readMetadata(
    sessionId: string,
  ): Promise<Result<RunnerSessionMetadata, RunnerSessionStoreError>> {
    return tryAsync(
      this.#readMetadataValue(sessionId),
      storeError("read-metadata", `Could not read runner session ${sessionId}`),
    );
  }

  async #readMetadataValue(sessionId: string): Promise<RunnerSessionMetadata> {
    const id = parse(sessionIdSchema, sessionId);
    const sessionPath = this.sessionPath(id);
    await assertRealDirectory(sessionPath, "Runner session directory");
    const metadata = await readMetadataFile(join(sessionPath, METADATA_FILE));
    if (metadata.id !== id) {
      throw new RunnerSessionDataError(
        `Session directory ${id} contains metadata for ${metadata.id}.`,
      );
    }
    if (metadata.runnerId !== this.#runnerId) {
      throw new RunnerSessionDataError(`Session ${id} belongs to a different runner.`);
    }
    return metadata;
  }

  updateSessionState(
    sessionId: string,
    state: RunnerSessionState,
  ): Promise<Result<RunnerSessionMetadata, RunnerSessionStoreError>> {
    return tryAsync(
      this.#updateSessionState(sessionId, state),
      storeError("update-session-state", `Could not update runner session ${sessionId}`),
    );
  }

  async #updateSessionState(
    sessionId: string,
    state: RunnerSessionState,
  ): Promise<RunnerSessionMetadata> {
    const metadata = await this.#readMetadataValue(sessionId);
    const updated = parseMetadata({
      ...metadata,
      state: parse(runnerSessionStateSchema, state),
    });
    await writeAtomicMetadata(join(this.sessionPath(metadata.id), METADATA_FILE), updated);
    return updated;
  }

  updateProvisioning(
    sessionId: string,
    input: UpdateRunnerSessionProvisioningInput,
  ): Promise<Result<RunnerSessionMetadata, RunnerSessionStoreError>> {
    return tryAsync(
      this.#updateProvisioning(sessionId, input),
      storeError("update-provisioning", `Could not update runner session ${sessionId}`),
    );
  }

  async #updateProvisioning(
    sessionId: string,
    input: UpdateRunnerSessionProvisioningInput,
  ): Promise<RunnerSessionMetadata> {
    const metadata = await this.#readMetadataValue(sessionId);
    const updated = parseMetadata({
      ...metadata,
      state: parse(runnerSessionStateSchema, input.state),
      checkoutState: parse(runnerCheckoutStateSchema, input.checkoutState),
      ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    });
    await writeAtomicMetadata(join(this.sessionPath(metadata.id), METADATA_FILE), updated);
    return updated;
  }

  getSessionWorkspacePath(sessionId: string): Promise<Result<string, RunnerSessionStoreError>> {
    return tryAsync(
      this.#getSessionWorkspacePath(sessionId),
      storeError("get-workspace-path", `Could not access runner session ${sessionId} workspace`),
    );
  }

  async #getSessionWorkspacePath(sessionId: string): Promise<string> {
    const metadata = await this.#readMetadataValue(sessionId);
    const workspacePath = join(this.sessionPath(metadata.id), "workspace");
    await assertRealDirectory(workspacePath, "Runner session workspace");
    return await Deno.realPath(workspacePath);
  }

  getSessionPiPaths(
    sessionId: string,
  ): Promise<Result<RunnerSessionPiPaths, RunnerSessionStoreError>> {
    return tryAsync(
      this.#getSessionPiPaths(sessionId),
      storeError("get-pi-paths", `Could not access runner session ${sessionId} Pi storage`),
    );
  }

  async #getSessionPiPaths(sessionId: string): Promise<RunnerSessionPiPaths> {
    const metadata = await this.#readMetadataValue(sessionId);
    const piDirectory = join(this.sessionPath(metadata.id), "pi");
    const agentDirectory = join(piDirectory, "agent");
    const sessionFile = join(this.sessionPath(metadata.id), PI_SESSION_FILE);
    await assertRealDirectory(piDirectory, "Runner session Pi directory");
    await assertRealDirectory(agentDirectory, "Runner session Pi agent directory");
    await assertRegularFile(sessionFile, "Runner session Pi session file");
    return {
      agentDirectory: await Deno.realPath(agentDirectory),
      sessionFile: await Deno.realPath(sessionFile),
    };
  }

  getSessionSnapshot(
    sessionId: string,
  ): Promise<Result<RunnerSessionSnapshot, RunnerSessionStoreError>> {
    return tryAsync(
      this.#getSessionSnapshot(sessionId),
      storeError("get-session-snapshot", `Could not snapshot runner session ${sessionId}`),
    );
  }

  async #getSessionSnapshot(sessionId: string): Promise<RunnerSessionSnapshot> {
    const metadata = await this.#readMetadataValue(sessionId);
    const history = await readPiSessionEvents(join(this.sessionPath(metadata.id), PI_SESSION_FILE));
    return snapshotFrom(metadata, history.length);
  }

  loadInventory(): Promise<Result<RunnerSessionInventory, RunnerSessionStoreError>> {
    return tryAsync(
      this.#loadInventory(),
      storeError("load-inventory", "Could not access the runner session inventory root"),
    );
  }

  async #loadInventory(): Promise<RunnerSessionInventory> {
    await ensurePrivateDirectory(this.sessionsPath());
    const sessions: RunnerSessionSnapshot[] = [];
    const errors: RunnerSessionInventoryError[] = [];
    const entries = [];
    for await (const entry of Deno.readDir(this.sessionsPath())) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = join(this.sessionsPath(), entry.name);
      if (!entry.isDirectory || entry.isSymlink) {
        errors.push({
          sessionDirectory: entry.name,
          message: "Session storage entries must be real directories.",
        });
        continue;
      }

      const metadataInspection = await this.#inspectMetadata(entry.name);
      if ("metadata" in metadataInspection) {
        const metadata = metadataInspection.metadata;
        if (!metadata) {
          errors.push({ sessionDirectory: entry.name, message: "Session metadata is invalid." });
          continue;
        }

        const [history, historyError] = await tryAsync(
          readPiSessionEvents(join(entryPath, PI_SESSION_FILE)),
          (cause) => new RunnerSessionDataError(errorMessage(cause)),
        );
        if (historyError !== undefined) {
          errors.push({ sessionDirectory: entry.name, message: historyError.message });
          sessions.push(snapshotFrom(metadata, 0, "error"));
          continue;
        }
        sessions.push(snapshotFrom(metadata, history.length));
      } else {
        errors.push({
          sessionDirectory: entry.name,
          message: errorMessage(metadataInspection.error),
        });
      }
    }

    return { sessions, errors };
  }

  async #inspectMetadata(
    sessionId: string,
  ): Promise<{ metadata: RunnerSessionMetadata } | { error: RunnerSessionStoreError }> {
    const [metadata, metadataError] = await this.readMetadata(sessionId);
    if (metadataError !== undefined) return { error: metadataError };
    return { metadata };
  }

  private sessionsPath(): string {
    return join(this.#workingDirectory, SESSIONS_DIRECTORY);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsPath(), sessionId);
  }
}

function parseMetadata(input: unknown): RunnerSessionMetadata {
  return parse(metadataSchema, input);
}

function snapshotFrom(
  metadata: RunnerSessionMetadata,
  lastEventCursor: number,
  state: RunnerSessionState = metadata.state,
): RunnerSessionSnapshot {
  return {
    id: metadata.id,
    projectId: metadata.projectId,
    createdAt: metadata.createdAt,
    initialPromptPreview: initialPromptPreview(metadata.initialPrompt),
    model: metadata.model,
    state,
    lastEventCursor,
  };
}

async function readMetadataFile(path: string): Promise<RunnerSessionMetadata> {
  using file = await openRegularFile(path, { read: true });
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    await readAll(file),
  ));
  return parseMetadata(value);
}

async function writeAtomicMetadata(path: string, metadata: RunnerSessionMetadata): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  const contents = new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`);
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    await tryAsync(Deno.remove(temporaryPath), () => undefined);
  });
  await writeNewPrivateFile(temporaryPath, contents);
  await Deno.rename(temporaryPath, path);
  await syncDirectory(dirname(path));
}

async function writeNewPrivateFile(path: string, contents: Uint8Array): Promise<void> {
  using file = await Deno.open(path, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  await writeAll(file, contents);
  await file.sync();
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { mode: 0o700, recursive: true });
  await assertRealDirectory(path, "Runner sessions directory");
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o700);
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new RunnerSessionDataError(`${label} must be a real directory.`);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new RunnerSessionDataError(`${label} must be a regular file.`);
  }
}

async function openRegularFile(path: string, options: Deno.OpenOptions): Promise<Deno.FsFile> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new RunnerSessionDataError(`${path} must be a regular file.`);
  }
  return await Deno.open(path, options);
}

async function readAll(file: Deno.FsFile): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const buffer = new Uint8Array(64 * 1024);
  while (true) {
    const bytesRead = await file.read(buffer);
    if (bytesRead === null) break;
    const chunk = buffer.slice(0, bytesRead);
    chunks.push(chunk);
    length += chunk.length;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function writeAll(file: Deno.FsFile, contents: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < contents.length) offset += await file.write(contents.subarray(offset));
}

async function syncDirectory(path: string): Promise<void> {
  using directory = await Deno.open(path, { read: true });
  await directory.sync();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RunnerSessionDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerSessionDataError";
  }
}

function storeError(
  operation: RunnerSessionStoreOperation,
  context: string,
): (cause: unknown) => RunnerSessionStoreError {
  return (cause) =>
    new RunnerSessionStoreError(operation, `${context}: ${errorMessage(cause)}`, cause);
}
