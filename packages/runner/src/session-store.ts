import {
  initialPromptPreview,
  projectIdSchema,
  runnerIdSchema,
  runnerSessionCreatedAtSchema,
  type RunnerSessionSnapshot,
  type RunnerSessionState,
  runnerSessionStateSchema,
  sessionIdSchema,
} from "@openorb/protocol";
import { type InferOutput, literal, number, object, parse, string } from "@remix-run/data-schema";
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
    initialPrompt: string().refine(
      (value) => initialPromptPreview(value).length > 0,
      "The initial prompt must contain non-whitespace text.",
    ),
    state: runnerSessionStateSchema,
  },
  { unknownKeys: "error" },
);

export type RunnerSessionMetadata = InferOutput<typeof metadataSchema>;

export interface CreateRunnerSessionInput {
  id: string;
  projectId: string;
  initialPrompt: string;
  createdAt?: string;
}

export type RunnerSessionEventValue =
  | null
  | boolean
  | number
  | string
  | RunnerSessionEventValue[]
  | RunnerSessionEventObject;

export interface RunnerSessionEventObject {
  [key: string]: RunnerSessionEventValue;
}

export interface RunnerSessionEvent extends RunnerSessionEventObject {
  type: string;
}

const sessionEventSchema = object(
  {
    type: string().refine(
      (value) => value.trim().length > 0 && value.length <= 128,
      "Session event types must contain between 1 and 128 characters.",
    ),
  },
  { unknownKeys: "passthrough" },
).transform((event): RunnerSessionEvent => event);

const storedSessionEventSchema = object(
  {
    cursor: number().refine(
      (value) => Number.isSafeInteger(value) && value > 0,
      "Session event cursors must be positive safe integers.",
    ),
    event: sessionEventSchema,
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

interface EventLogInspection {
  records: StoredRunnerSessionEvent[];
  error?: Error;
}

export class RunnerSessionStore {
  readonly #workingDirectory: string;
  readonly #runnerId: string;
  readonly #eventWrites = new Map<string, Promise<number>>();

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
      initialPrompt: input.initialPrompt,
      state: "created",
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
      return metadata;
    } catch (error) {
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

      const eventLog = await inspectEventLog(join(entryPath, EVENTS_FILE));
      const lastEventCursor = eventLog.records.at(-1)?.cursor ?? 0;
      if (eventLog.error) {
        errors.push({ sessionDirectory: entry.name, message: eventLog.error.message });
      }
      sessions.push({
        id: metadata.id,
        projectId: metadata.projectId,
        createdAt: metadata.createdAt,
        initialPromptPreview: initialPromptPreview(metadata.initialPrompt),
        state: eventLog.error ? "error" : metadata.state,
        lastEventCursor,
      });
    }

    return { sessions, errors };
  }

  async readEvents(sessionId: string): Promise<StoredRunnerSessionEvent[]> {
    const metadata = await this.readMetadata(sessionId);
    const inspection = await inspectEventLog(join(this.sessionPath(metadata.id), EVENTS_FILE));
    if (inspection.error) throw inspection.error;
    return inspection.records;
  }

  appendEvent(sessionId: string, event: RunnerSessionEvent): Promise<number> {
    const id = parse(sessionIdSchema, sessionId);
    const parsedEvent = parseSessionEvent(event);
    const previous = this.#eventWrites.get(id) ?? Promise.resolve(0);
    const pending = previous.catch(() => 0).then(async () => {
      const metadata = await this.readMetadata(id);
      const path = join(this.sessionPath(metadata.id), EVENTS_FILE);
      const inspection = await inspectEventLog(path);
      if (inspection.error) throw inspection.error;

      const cursor = (inspection.records.at(-1)?.cursor ?? 0) + 1;
      const record: StoredRunnerSessionEvent = { cursor, event: parsedEvent };
      const contents = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
      const file = await openRegularFile(path, { write: true, append: true });
      try {
        await writeAll(file, contents);
        await file.sync();
      } finally {
        file.close();
      }
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
}

function parseMetadata(input: unknown): RunnerSessionMetadata {
  return parse(metadataSchema, input);
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

async function inspectEventLog(path: string): Promise<EventLogInspection> {
  let text: string;
  try {
    const file = await openRegularFile(path, { read: true });
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await readAll(file));
    } finally {
      file.close();
    }
  } catch (error) {
    return { records: [], error: corruptEventLog(errorMessage(error)) };
  }

  if (text.length === 0) return { records: [] };
  const records: StoredRunnerSessionEvent[] = [];
  const completeEnd = text.endsWith("\n") ? text.length - 1 : text.lastIndexOf("\n");
  const lines = completeEnd < 0 ? [] : text.slice(0, completeEnd).split("\n");
  for (const [index, line] of lines.entries()) {
    try {
      const record = parseStoredEvent(JSON.parse(line));
      const expectedCursor = index + 1;
      if (record.cursor !== expectedCursor) {
        throw new Error(`expected cursor ${expectedCursor}, found ${record.cursor}`);
      }
      records.push(record);
    } catch (error) {
      return {
        records,
        error: corruptEventLog(`line ${index + 1} is invalid: ${errorMessage(error)}`),
      };
    }
  }
  if (!text.endsWith("\n")) {
    return {
      records,
      error: corruptEventLog("the final append is incomplete"),
    };
  }
  return { records };
}

function parseStoredEvent(input: unknown): StoredRunnerSessionEvent {
  return parse(storedSessionEventSchema, input);
}

function parseSessionEvent(input: unknown): RunnerSessionEvent {
  return parse(sessionEventSchema, input);
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
