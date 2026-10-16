// Transport adapted from upstream pi-env's `Connection` (MIT, see ../LICENSE); see README.md.
// Upstream protocol code keeps its own idioms instead of OpenOrb boundary-parsing conventions.
// oxlint-disable openorb/no-chained-type-assertions, openorb/no-runtime-typeof, openorb/no-unknown-returns, openorb/no-unsafe-dictionary-type, openorb/prefer-disposable-stack

import {
  Connection,
  RemoteError,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
} from "@earendil-works/pi-env";

/** Frame types (pi-env docs/protocol.md). */
const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;

export const MAX_FRAME = 16 * 1024 * 1024;
const HEADER_BYTES = 13;
const PING_INTERVAL_MS = 5000;
/** The relay echoes each ping; this much silence while requests are in flight means the link is gone. */
const SILENCE_LIMIT_MS = 30_000;
/** How long opening the link and the daemon's `hello` may take. */
const START_TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;

/**
 * One open link to a started daemon. Each message carries exactly one complete protocol frame in
 * either direction; the relay has already consumed the daemon's sync line.
 */
export interface EnvLink {
  send(frame: Uint8Array): void;
  /** Closing the link stops the daemon and everything it started. */
  close(): void;
}

export interface EnvLinkHandlers {
  frame(frame: Uint8Array): void;
  closed(reason: string): void;
}

export interface ConnectionOptions {
  /**
   * Opens a link to a daemon, or reuses one that is already open. Called lazily on the first
   * request and again after the link is lost; a failed open is not remembered.
   */
  open: (handlers: EnvLinkHandlers, signal: AbortSignal) => Promise<EnvLink>;
  /** Receives transport diagnostics. */
  onLog?: (text: string) => void;
}

type Pending = {
  resolve: (value: Reply) => void;
  reject: (error: Error) => void;
  onEvent?: (json: Json, payload: Uint8Array) => void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Lone surrogates become U+FFFD, as Node encodes strings for system calls. */
function wellFormed(_key: string, value: unknown): unknown {
  return typeof value === "string" ? value.toWellFormed() : value;
}

function frame(
  type: number,
  id: number,
  json: Json,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const body = encoder.encode(JSON.stringify(json, wellFormed));
  const bytes = new Uint8Array(HEADER_BYTES + body.length + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 9 + body.length + payload.length);
  view.setUint8(4, type);
  view.setUint32(5, id);
  view.setUint32(9, body.length);
  bytes.set(body, HEADER_BYTES);
  bytes.set(payload, HEADER_BYTES + body.length);
  return bytes;
}

/** The link failed or ended; a request may succeed once it is opened again. */
function lost(message: string): RemoteError {
  return new RemoteError({ code: "unknown", message, lost: true });
}

function closed(): RemoteError {
  return new RemoteError({ code: "unknown", message: "Connection closed" });
}

/**
 * A random first request id. A Durable Object that wakes from hibernation reopens an existing
 * link whose daemon may still answer requests of the evicted instance; distinct ids keep those
 * stale replies from settling new requests.
 */
function firstRequestId(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0]! % 0x7fff_ffff) + 1;
}

/** One opened link. */
class Session {
  readonly id: number;
  link: EnvLink | undefined;
  readonly pending = new Map<number, Pending>();
  lastSeen = Date.now();
  timer: ReturnType<typeof setInterval> | undefined;
  live = true;

  constructor(id: number) {
    this.id = id;
  }
}

/**
 * One connection to a pi-env daemon over an {@link EnvLink}: opened lazily on the first request
 * and opened again after it is lost. Requests in flight when it is lost fail with code `unknown`;
 * for mutations their outcome is then unknown.
 *
 * Liveness costs nothing while idle: the client pings only while requests are in flight, and the
 * relay answers the daemon's own pings next to it.
 *
 * It replaces every public method of upstream's `Connection`, which can only spawn the daemon as a
 * process, so upstream's `RemoteExecutionEnv` runs over it unchanged.
 */
export class LinkConnection extends Connection {
  readonly #options: ConnectionOptions;
  #session: Session | undefined;
  #ready: Promise<{ info: RemoteInfo; session: Session }> | undefined;
  #sessions = 0;
  #nextId = firstRequestId();
  #closed = false;

  constructor(options: ConnectionOptions) {
    // Never started: every method that would spawn the daemon is overridden.
    super({ command: () => Promise.reject(new Error("pi-env runs over an Environment Link")) });
    this.#options = options;
  }

  /** Connect if needed and return what the daemon reported about its machine. */
  override async info(): Promise<RemoteInfo> {
    return (await this.#connect()).info;
  }

  /** Connect if needed and return the live session's id. */
  override async session(): Promise<number> {
    return (await this.#connect()).session.id;
  }

  override async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
    if (options.session !== undefined) {
      const current = this.#session;
      if (current === undefined || current.id !== options.session || !current.live) {
        throw lost("pi-env connection lost");
      }
      return this.#send(current, op, json, options);
    }
    const { session } = await this.#connect();
    return this.#send(session, op, json, options);
  }

  /** Close the link; the daemon kills everything it started. */
  override close(): void {
    this.#closed = true;
    if (this.#session) this.#teardown(this.#session, closed());
  }

  /** Fail requests in flight because the link closed underneath this connection. */
  lost(reason: string): void {
    if (this.#session) this.#teardown(this.#session, lost(reason));
  }

  /** Kill one `exec` without aborting it. */
  override kill(id: number, session: number): void {
    const current = this.#session;
    if (current?.id === session && current.live) {
      this.#write(current, frame(CANCEL, id, { mode: "kill" }));
    }
  }

  #connect(): Promise<{ info: RemoteInfo; session: Session }> {
    if (this.#closed) return Promise.reject(closed());
    if (this.#ready === undefined) {
      const ready = this.#start();
      this.#ready = ready;
      // A failed start is not remembered: the next request tries again.
      ready.catch(() => {
        if (this.#ready === ready) this.#ready = undefined;
      });
    }
    return this.#ready;
  }

  #nextRequestId(): number {
    const id = this.#nextId;
    this.#nextId = id >= 0xffff_ffff ? 1 : id + 1;
    return id;
  }

  #send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
    if (!session.live) return Promise.reject(lost("pi-env connection lost"));
    const id = this.#nextRequestId();
    return new Promise((resolve, reject) => {
      const onAbort = () => this.#write(session, frame(CANCEL, id, {}));
      const done = () => {
        options.signal?.removeEventListener("abort", onAbort);
        this.#updateHeartbeat(session);
      };
      session.pending.set(id, {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });
      this.#updateHeartbeat(session);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      options.onStart?.(id, session.id);
      this.#write(session, frame(REQUEST, id, { ...json, op }, options.payload));
      if (options.signal?.aborted) onAbort();
    });
  }

  /** Ping only while requests are in flight, so an idle link never wakes either side. */
  #updateHeartbeat(session: Session): void {
    if (!session.live || session.pending.size === 0) {
      clearInterval(session.timer);
      session.timer = undefined;
      return;
    }
    if (session.timer !== undefined) return;
    session.lastSeen = Date.now();
    session.timer = setInterval(() => {
      this.#write(session, frame(PING, 0, {}));
      if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS) {
        this.#teardown(session, lost("pi-env connection timed out"));
      }
    }, PING_INTERVAL_MS);
  }

  #write(session: Session, data: Uint8Array): void {
    if (!session.live || session.link === undefined) return;
    try {
      session.link.send(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#teardown(session, lost(`pi-env link failed: ${message}`));
    }
  }

  async #start(): Promise<{ info: RemoteInfo; session: Session }> {
    if (this.#closed) throw closed();
    const session = new Session(++this.#sessions);
    this.#session = session;
    const controller = new AbortController();
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      startTimer = setTimeout(() => {
        controller.abort();
        reject(lost(`pi-env did not answer within ${START_TIMEOUT_MS / 1000} s`));
      }, START_TIMEOUT_MS);
    });
    failed.catch(() => {});
    try {
      const link = await Promise.race([
        this.#options.open(
          {
            frame: (bytes) => this.#onFrame(session, bytes),
            closed: (reason) => this.#teardown(session, lost(`pi-env link closed: ${reason}`)),
          },
          controller.signal,
        ),
        failed,
      ]);
      if (!session.live) {
        link.close();
        throw lost("pi-env link closed while opening");
      }
      session.link = link;
      const { json } = await Promise.race([
        this.#send(session, "hello", { protocol: 1 }, {}),
        failed,
      ]);
      if (json.protocol !== 1) throw lost(`Unsupported protocol ${json.protocol}`);
      // SAFETY: protocol 1 `hello` replies carry every RemoteInfo field (pi-env docs/protocol.md).
      return { info: json as unknown as RemoteInfo, session };
    } catch (error) {
      const cause =
        error instanceof RemoteError
          ? error
          : lost(error instanceof Error ? error.message : String(error));
      this.#teardown(session, cause);
      throw cause;
    } finally {
      clearTimeout(startTimer);
    }
  }

  #teardown(session: Session, error: Error): void {
    if (!session.live) return;
    session.live = false;
    clearInterval(session.timer);
    if (this.#session === session) {
      this.#session = undefined;
      this.#ready = undefined;
    }
    try {
      session.link?.close();
    } catch {
      // The link is already gone.
    }
    const pending = [...session.pending.values()];
    session.pending.clear();
    for (const request of pending) request.reject(error);
  }

  #onFrame(session: Session, bytes: Uint8Array): void {
    if (!session.live) return;
    session.lastSeen = Date.now();
    const parsed = parseFrame(bytes);
    if (parsed === undefined) {
      this.#teardown(session, lost("Corrupt frame from pi-env"));
      return;
    }
    this.#dispatch(session, parsed);
  }

  #dispatch(session: Session, { type, id, json, payload }: Frame): void {
    const pending = session.pending.get(id);
    if (type === EVENT) {
      pending?.onEvent?.(json, payload);
      return;
    }
    if (type !== RESULT && type !== ERROR) return;
    if (pending === undefined) return;
    session.pending.delete(id);
    if (type === RESULT) pending.resolve({ json, payload, session: session.id });
    else pending.reject(new RemoteError(json));
  }
}

export interface Frame {
  type: number;
  id: number;
  json: Json;
  payload: Uint8Array;
}

/** Parses exactly one complete frame, or `undefined` when it is malformed. */
export function parseFrame(bytes: Uint8Array): Frame | undefined {
  if (bytes.length < HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  if (length < 9 || length > MAX_FRAME || length !== bytes.length - 4) return undefined;
  const type = view.getUint8(4);
  const id = view.getUint32(5);
  const jsonLength = view.getUint32(9);
  if (9 + jsonLength > length) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + jsonLength)));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  // SAFETY: checked above to be a non-null, non-array JSON object.
  const json = parsed as Json;
  // A plain copy, like Node's file reader results, not a view of the receive buffer.
  return { type, id, json, payload: bytes.slice(HEADER_BYTES + jsonLength) };
}

/** Frame types the relay needs to recognise. */
export const FrameType = { PING } as const;

/** The constant ping frame both sides send. */
export const PING_FRAME: Uint8Array = frame(PING, 0, {});
