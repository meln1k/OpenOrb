import { FrameType, MAX_FRAME, PING_FRAME } from "./connection.ts";
import { DaemonOutput } from "./daemon-output.ts";

/** The daemon pings every five seconds; this much silence means it is gone. */
const DAEMON_SILENCE_LIMIT_MS = 30_000;

export class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayError";
  }
}

export interface DaemonRelayEndpoints {
  /** Writes bytes to the daemon's stdin. */
  toDaemon(bytes: Uint8Array): void;
  /** Sends one complete frame over the Environment Link. */
  toLink(frame: Uint8Array): void;
  /** Receives output the daemon's start printed before its sync line. */
  onNoise?(text: string): void;
}

function frameType(frame: Uint8Array): number {
  return frame[4]!;
}

/**
 * Joins a daemon's stdio to an Environment Link without interpreting requests. Liveness is local
 * on both sides so an idle link carries no traffic: daemon pings are answered here instead of
 * crossing the link, and link pings are echoed here instead of reaching the daemon.
 */
export class DaemonRelay {
  readonly #endpoints: DaemonRelayEndpoints;
  readonly #output: DaemonOutput;
  #lastDaemonOutput = Date.now();

  constructor(token: string, endpoints: DaemonRelayEndpoints) {
    this.#endpoints = endpoints;
    this.#output = new DaemonOutput(token, (text) => endpoints.onNoise?.(text));
  }

  /** Forwards one stdout chunk of the daemon. Throws `DaemonOutputError` on corrupt output. */
  fromDaemon(chunk: Uint8Array): void {
    this.#lastDaemonOutput = Date.now();
    for (const frame of this.#output.push(chunk)) {
      if (frameType(frame) === FrameType.PING) continue;
      this.#endpoints.toLink(frame);
    }
  }

  /** Forwards one link message, which must be exactly one frame. */
  fromLink(message: Uint8Array): void {
    if (message.length < 13) throw new RelayError("Link frame is too short");
    const length = new DataView(message.buffer, message.byteOffset, 4).getUint32(0);
    if (length < 9 || length > MAX_FRAME || length !== message.length - 4) {
      throw new RelayError("Link message is not exactly one frame");
    }
    if (frameType(message) === FrameType.PING) {
      this.#endpoints.toLink(PING_FRAME);
      return;
    }
    this.#endpoints.toDaemon(message);
  }

  /**
   * Keeps the daemon from timing out; call every five seconds. Throws once the daemon has been
   * silent for longer than its own silence limit.
   */
  pingDaemon(now = Date.now()): void {
    if (now - this.#lastDaemonOutput > DAEMON_SILENCE_LIMIT_MS) {
      throw new RelayError("pi-env daemon stopped answering");
    }
    this.#endpoints.toDaemon(PING_FRAME);
  }
}
