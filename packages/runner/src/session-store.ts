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
  readonly #eventWrites = new Map<string, Promise<number>>();
  readonly #eventCursors = new Map<string, EventCursor>();

  constructor(options: { workingDirectory: string; runnerId: string }) {
    this.#workingDirectory = options.workingDirectory;
    this.#runnerId = parse(runnerIdSchema, options.runnerId);
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.sessionsPath());
  }

  async createSession(input: CreateRunnerSessionInput): Promise<RunnerSessionMetadata> {
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

    await this.initialize();
    const sessionPath = this.sessionPath(metadata.id);
    await Deno.mkdir(sessionPath, { mode: 0o700 });
    try {
      for (const directory of ["workspace", "pi", "logs", "reports"]) {
        await Deno.mkdir(join(sessionPath, directory), { mode: 0o700 });
      }
      await writeNewPrivateFile(join(sessionPath, EVENTS_FILE), new Uint8Array());
      await writeNewPrivateFile(join(sessionPath, PI_SESSION_FILE), new Uint8Array());
      await writeAtomicMetadata(join(sessionPath, METADATA_FILE), metadata);
      await syncDirectory(this.sessionsPath());
      this.#eventCursors.set(metadata.id, { value: 0, byteLength: 0 });
      return metadata;
    } catch (error) {
      this.#eventCursors.delete(metadata.id);
      await Deno.remove(sessionPath, { recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async readMetadata(sessionId: string): Promise<RunnerSessionMetadata> {
    const id = parse(sessionIdSchema, sessionId);
    const sessionPath = this.sessionPath(id);
    await assertRealDirectory(sessionPath, "Runner session directory");
    const metadata = await readMetadataFile(join(sessionPath, METADATA_FILE));
    if (metadata.id !== id) {
      throw new Error(`Session directory ${id} contains metadata for ${metadata.id}.`);
    }
    if (metadata.runnerId !== this.#runnerId) {
      throw new Error(`Session ${id} belongs to a different runner.`);
    }
    return metadata;
  }

  async updateSessionState(
    sessionId: string,
    state: RunnerSessionState,
  ): Promise<RunnerSessionMetadata> {
    const metadata = await this.readMetadata(sessionId);
    const updated = parseMetadata({
      ...metadata,
      state: parse(runnerSessionStateSchema, state),
    });
    await writeAtomicMetadata(join(this.sessionPath(metadata.id), METADATA_FILE), updated);
    return updated;
  }

  async updateProvisioning(
    sessionId: string,
    input: UpdateRunnerSessionProvisioningInput,
  ): Promise<RunnerSessionMetadata> {
    const metadata = await this.readMetadata(sessionId);
    const updated = parseMetadata({
      ...metadata,
      state: parse(runnerSessionStateSchema, input.state),
      checkoutState: parse(runnerCheckoutStateSchema, input.checkoutState),
      ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    });
    await writeAtomicMetadata(join(this.sessionPath(metadata.id), METADATA_FILE), updated);
    return updated;
  }

  async getSessionWorkspacePath(sessionId: string): Promise<string> {
    const metadata = await this.readMetadata(sessionId);
    const workspacePath = join(this.sessionPath(metadata.id), "workspace");
    await assertRealDirectory(workspacePath, "Runner session workspace");
    return await Deno.realPath(workspacePath);
  }

  async getSessionSnapshot(sessionId: string): Promise<RunnerSessionSnapshot> {
    const metadata = await this.readMetadata(sessionId);
    const eventLog = await iterateEventLog(
      join(this.sessionPath(metadata.id), EVENTS_FILE),
      () => {},
    );
    if (eventLog.error) throw eventLog.error;
    this.#rememberEventCursor(metadata.id, eventLog);
    return snapshotFrom(metadata, eventLog.lastCursor);
  }

  async loadInventory(): Promise<RunnerSessionInventory> {
    await this.initialize();
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

      let metadata: RunnerSessionMetadata;
      try {
        metadata = await this.readMetadata(entry.name);
      } catch (error) {
        errors.push({ sessionDirectory: entry.name, message: errorMessage(error) });
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
    }

    return { sessions, errors };
  }

  async readEvents(sessionId: string): Promise<StoredRunnerSessionEvent[]> {
    const records: StoredRunnerSessionEvent[] = [];
    await this.forEachEvent(sessionId, (record) => {
      records.push(record);
    });
    return records;
  }

  async forEachEvent(
    sessionId: string,
    visit: (record: StoredRunnerSessionEvent) => void | Promise<void>,
  ): Promise<void> {
    const metadata = await this.readMetadata(sessionId);
    const inspection = await iterateEventLog(
      join(this.sessionPath(metadata.id), EVENTS_FILE),
      visit,
    );
    if (inspection.error) throw inspection.error;
    this.#rememberEventCursor(metadata.id, inspection);
  }

  appendEvent(sessionId: string, event: SessionProvisioningEvent): Promise<number> {
    const id = parse(sessionIdSchema, sessionId);
    const parsedEvent = parseSessionEvent(event);
    const previous = this.#eventWrites.get(id) ?? Promise.resolve(0);
    const pending = previous.catch(() => 0).then(async () => {
      const metadata = await this.readMetadata(id);
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
      try {
        const file = await openRegularFile(path, { write: true, append: true });
        try {
          await writeAll(file, contents);
          await file.sync();
        } finally {
          file.close();
        }
      } catch (error) {
        this.#eventCursors.delete(id);
        throw error;
      }
      this.#eventCursors.set(id, {
        value: cursor,
        byteLength: cursorState.byteLength + contents.byteLength,
      });
      return cursor;
    });
    this.#eventWrites.set(id, pending);
    return pending.finally(() => {
      if (this.#eventWrites.get(id) === pending) this.#eventWrites.delete(id);
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
  try {
    const file = await openRegularFile(path, { read: true });
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await readAll(file),
      ));
      return parseMetadata(value);
    } finally {
      file.close();
    }
  } catch (error) {
    throw new Error(`Session metadata is invalid: ${errorMessage(error)}`);
  }
}

async function iterateEventLog(
  path: string,
  visit: (record: StoredRunnerSessionEvent) => void | Promise<void>,
): Promise<EventCursorInspection> {
  let file: Deno.FsFile;
  try {
    file = await openRegularFile(path, { read: true });
  } catch (error) {
    return { lastCursor: 0, byteLength: 0, error: corruptEventLog(errorMessage(error)) };
  }

  const buffer = new Uint8Array(64 * 1024);
  let lineBytes: number[] = [];
  let lastCursor = 0;
  let byteLength = 0;
  try {
    while (true) {
      let bytesRead: number | null;
      try {
        bytesRead = await file.read(buffer);
      } catch (error) {
        return { lastCursor, byteLength, error: corruptEventLog(errorMessage(error)) };
      }
      if (bytesRead === null) break;
      byteLength += bytesRead;
      for (const byte of buffer.subarray(0, bytesRead)) {
        if (byte !== 0x0a) {
          lineBytes.push(byte);
          continue;
        }
        let record: StoredRunnerSessionEvent;
        try {
          const line = new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(lineBytes),
          );
          record = parseStoredEvent(JSON.parse(line));
          const expectedCursor = lastCursor + 1;
          if (record.cursor !== expectedCursor) {
            throw new Error(`expected cursor ${expectedCursor}, found ${record.cursor}`);
          }
        } catch (error) {
          return {
            lastCursor,
            byteLength,
            error: corruptEventLog(`line ${lastCursor + 1} is invalid: ${errorMessage(error)}`),
          };
        }
        await visit(record);
        lastCursor = record.cursor;
        lineBytes = [];
      }
    }
  } finally {
    file.close();
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
  try {
    await writeNewPrivateFile(temporaryPath, contents);
    await Deno.rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await Deno.remove(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function writeNewPrivateFile(path: string, contents: Uint8Array): Promise<void> {
  const file = await Deno.open(path, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  try {
    await writeAll(file, contents);
    await file.sync();
  } finally {
    file.close();
  }
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  await assertRealDirectory(path, "Runner sessions directory");
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o700);
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) throw new Error(`${label} must be a real directory.`);
}

async function openRegularFile(path: string, options: Deno.OpenOptions): Promise<Deno.FsFile> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) throw new Error(`${path} must be a regular file.`);
  return await Deno.open(path, options);
}

async function regularFileSize(path: string): Promise<number> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) throw new Error(`${path} must be a regular file.`);
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
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
