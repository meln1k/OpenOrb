import {
  initialPromptPreview,
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
  type SessionProvisioningEvent,
  sessionProvisioningEventSchema,
  sessionRepositoryUrlSchema,
} from "@openorb/protocol";
import {
  type InferOutput,
  literal,
  number,
  object,
  optional,
  parse,
  string,
} from "@remix-run/data-schema";
import { dirname, join } from "node:path";
import { ok, type Result, tryAsync, trySync } from "@openorb/result";

const SESSIONS_DIRECTORY = "sessions";
const METADATA_FILE = "metadata.json";
const EVENTS_FILE = "events.jsonl";
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
  createdAt?: string;
}

export interface UpdateRunnerSessionProvisioningInput {
  state: RunnerSessionState;
  checkoutState: RunnerCheckoutState;
  baseCommit?: string;
}

const storedSessionEventSchema = object(
  {
    cursor: number().refine(
      (value) => Number.isSafeInteger(value) && value > 0,
      "Session event cursors must be positive safe integers.",
    ),
    event: sessionProvisioningEventSchema,
  },
  { unknownKeys: "error" },
);

export type StoredRunnerSessionEvent = InferOutput<typeof storedSessionEventSchema>;

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
  | "get-session-snapshot"
  | "load-inventory"
  | "read-events"
  | "append-event";

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

interface EventCursorInspection {
  lastCursor: number;
  byteLength: number;
  error?: Error;
}

interface EventCursor {
  value: number;
  byteLength: number;
}

export class RunnerSessionStore {
  readonly #workingDirectory: string;
  readonly #runnerId: string;
  readonly #eventWrites = new Map<string, Promise<Result<number, RunnerSessionStoreError>>>();
  readonly #eventCursors = new Map<string, EventCursor>();

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
      this.#eventCursors.delete(metadata.id);
      await tryAsync(Deno.remove(sessionPath, { recursive: true }), () => undefined);
    });

    for (const directory of ["workspace", "pi", "logs", "reports"]) {
      await Deno.mkdir(join(sessionPath, directory), { mode: 0o700 });
    }
    await writeNewPrivateFile(join(sessionPath, EVENTS_FILE), new Uint8Array());
    await writeNewPrivateFile(join(sessionPath, PI_SESSION_FILE), new Uint8Array());
    await writeAtomicMetadata(join(sessionPath, METADATA_FILE), metadata);
    await syncDirectory(this.sessionsPath());
    this.#eventCursors.set(metadata.id, { value: 0, byteLength: 0 });
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
    const eventLog = await iterateEventLog(
      join(this.sessionPath(metadata.id), EVENTS_FILE),
      () => {},
    );
    if (eventLog.error) throw eventLog.error;
    this.#rememberEventCursor(metadata.id, eventLog);
    return snapshotFrom(metadata, eventLog.lastCursor);
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

        const eventLog = await iterateEventLog(join(entryPath, EVENTS_FILE), () => {});
        if (eventLog.error) {
          errors.push({ sessionDirectory: entry.name, message: eventLog.error.message });
        } else {
          this.#rememberEventCursor(metadata.id, eventLog);
        }
        sessions.push(
          snapshotFrom(metadata, eventLog.lastCursor, eventLog.error ? "error" : undefined),
        );
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

  readEvents(
    sessionId: string,
  ): Promise<Result<StoredRunnerSessionEvent[], RunnerSessionStoreError>> {
    return tryAsync(
      this.#readEvents(sessionId),
      storeError("read-events", `Could not read events for runner session ${sessionId}`),
    );
  }

  async #readEvents(sessionId: string): Promise<StoredRunnerSessionEvent[]> {
    const records: StoredRunnerSessionEvent[] = [];
    await this.#forEachEvent(sessionId, (record) => {
      records.push(record);
    });
    return records;
  }

  forEachEvent(
    sessionId: string,
    visit: (record: StoredRunnerSessionEvent) => void | Promise<void>,
  ): Promise<Result<void, RunnerSessionStoreError>> {
    return tryAsync(
      this.#forEachEvent(sessionId, visit),
      storeError("read-events", `Could not read events for runner session ${sessionId}`),
    );
  }

  async #forEachEvent(
    sessionId: string,
    visit: (record: StoredRunnerSessionEvent) => void | Promise<void>,
  ): Promise<void> {
    const metadata = await this.#readMetadataValue(sessionId);
    const inspection = await iterateEventLog(
      join(this.sessionPath(metadata.id), EVENTS_FILE),
      visit,
    );
    if (inspection.error) throw inspection.error;
    this.#rememberEventCursor(metadata.id, inspection);
  }

  appendEvent(
    sessionId: string,
    event: SessionProvisioningEvent,
  ): Promise<Result<number, RunnerSessionStoreError>> {
    const previous = this.#eventWrites.get(sessionId) ?? Promise.resolve(ok(0));
    const pending = tryAsync(
      previous.then(async () => {
        const id = parse(sessionIdSchema, sessionId);
        const parsedEvent = parseSessionEvent(event);
        const metadata = await this.#readMetadataValue(id);
        const path = join(this.sessionPath(metadata.id), EVENTS_FILE);
        let cursorState = this.#eventCursors.get(id);
        if (cursorState && cursorState.byteLength !== await regularFileSize(path)) {
          this.#eventCursors.delete(id);
          cursorState = undefined;
        }
        if (!cursorState) {
          const inspection = await iterateEventLog(path, () => {});
          if (inspection.error) throw inspection.error;
          cursorState = { value: inspection.lastCursor, byteLength: inspection.byteLength };
          this.#eventCursors.set(id, cursorState);
        }

        const cursor = cursorState.value + 1;
        const record: StoredRunnerSessionEvent = { cursor, event: parsedEvent };
        const contents = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
        {
          let writeSucceeded = false;
          using rollback = new DisposableStack();
          rollback.defer(() => {
            if (!writeSucceeded) this.#eventCursors.delete(id);
          });
          {
            using file = await openRegularFile(path, { write: true, append: true });
            await writeAll(file, contents);
            await file.sync();
          }
          writeSucceeded = true;
        }
        this.#eventCursors.set(id, {
          value: cursor,
          byteLength: cursorState.byteLength + contents.byteLength,
        });
        return cursor;
      }),
      storeError("append-event", `Could not append event for runner session ${sessionId}`),
    );
    this.#eventWrites.set(sessionId, pending);
    return pending.finally(() => {
      if (this.#eventWrites.get(sessionId) === pending) this.#eventWrites.delete(sessionId);
    });
  }

  private sessionsPath(): string {
    return join(this.#workingDirectory, SESSIONS_DIRECTORY);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsPath(), sessionId);
  }

  #rememberEventCursor(sessionId: string, inspection: EventCursorInspection): void {
    if (!this.#eventCursors.has(sessionId) && !this.#eventWrites.has(sessionId)) {
      this.#eventCursors.set(sessionId, {
        value: inspection.lastCursor,
        byteLength: inspection.byteLength,
      });
    }
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

async function iterateEventLog(
  path: string,
  visit: (record: StoredRunnerSessionEvent) => void | Promise<void>,
): Promise<EventCursorInspection> {
  const [openedFile, openError] = await tryAsync(
    openRegularFile(path, { read: true }),
    (cause) => corruptEventLog(errorMessage(cause)),
  );
  if (openError !== undefined) return { lastCursor: 0, byteLength: 0, error: openError };
  using file = openedFile;

  const buffer = new Uint8Array(64 * 1024);
  let lineBytes: number[] = [];
  let lastCursor = 0;
  let byteLength = 0;
  while (true) {
    const [bytesRead, readError] = await tryAsync(
      file.read(buffer),
      (cause) => corruptEventLog(errorMessage(cause)),
    );
    if (readError !== undefined) return { lastCursor, byteLength, error: readError };
    if (bytesRead === null) break;
    byteLength += bytesRead;
    for (const byte of buffer.subarray(0, bytesRead)) {
      if (byte !== 0x0a) {
        lineBytes.push(byte);
        continue;
      }
      const [record, recordError] = trySync(
        () => {
          const line = new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(lineBytes),
          );
          return parseStoredEvent(JSON.parse(line));
        },
        (cause) => new RunnerSessionDataError(errorMessage(cause)),
      );
      if (recordError !== undefined) {
        return {
          lastCursor,
          byteLength,
          error: corruptEventLog(
            `line ${lastCursor + 1} is invalid: ${errorMessage(recordError)}`,
          ),
        };
      }
      const expectedCursor = lastCursor + 1;
      if (record.cursor !== expectedCursor) {
        return {
          lastCursor,
          byteLength,
          error: corruptEventLog(
            `line ${expectedCursor} is invalid: expected cursor ${expectedCursor}, found ${record.cursor}`,
          ),
        };
      }
      await visit(record);
      lastCursor = record.cursor;
      lineBytes = [];
    }
  }
  if (lineBytes.length > 0) {
    return { lastCursor, byteLength, error: corruptEventLog("the final append is incomplete") };
  }
  return { lastCursor, byteLength };
}

function parseStoredEvent(input: unknown): StoredRunnerSessionEvent {
  return parse(storedSessionEventSchema, input);
}

function parseSessionEvent(input: unknown): SessionProvisioningEvent {
  return parse(sessionProvisioningEventSchema, input);
}

function corruptEventLog(message: string): Error {
  return new Error(`Session event log is corrupt: ${message}.`);
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

async function openRegularFile(path: string, options: Deno.OpenOptions): Promise<Deno.FsFile> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new RunnerSessionDataError(`${path} must be a regular file.`);
  }
  return await Deno.open(path, options);
}

async function regularFileSize(path: string): Promise<number> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new RunnerSessionDataError(`${path} must be a regular file.`);
  }
  return info.size;
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
