import { MAX_FRAME } from "./connection.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Output before the sync line that is kept while searching for it. */
const MAX_NOISE = 1024 * 1024;

export class DaemonOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonOutputError";
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

/**
 * Splits a daemon's stdout into complete protocol frames. Output before the daemon's
 * `PI-ENV <token>` sync line is reported as noise, as upstream `Connection` does for SSH.
 */
export class DaemonOutput {
  readonly #marker: Uint8Array;
  readonly #onNoise: ((text: string) => void) | undefined;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #synced = false;

  constructor(token: string, onNoise?: (text: string) => void) {
    this.#marker = encoder.encode(`PI-ENV ${token}\n`);
    this.#onNoise = onNoise;
  }

  get synced(): boolean {
    return this.#synced;
  }

  /** Accepts one stdout chunk and returns every frame it completes. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length === 0) return [];
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    if (!this.#synced && !this.#sync()) return [];
    const frames: Uint8Array[] = [];
    while (this.#buffered >= 4) {
      const header = this.#peek(4);
      const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0);
      if (length < 9 || length > MAX_FRAME) {
        throw new DaemonOutputError("Corrupt frame from pi-env");
      }
      if (this.#buffered < 4 + length) break;
      frames.push(this.#peek(4 + length).slice());
      this.#consume(4 + length);
    }
    return frames;
  }

  #sync(): boolean {
    const all = this.#peek(this.#buffered);
    const index = indexOf(all, this.#marker);
    if (index === -1) {
      if (this.#buffered > MAX_NOISE) this.#consume(this.#buffered - this.#marker.length);
      return false;
    }
    const noise = decoder.decode(all.subarray(0, index)).trim();
    if (noise !== "") this.#onNoise?.(noise);
    this.#consume(index + this.#marker.length);
    this.#synced = true;
    return true;
  }

  /** The first `length` buffered bytes, joining chunks only when the first one is too short. */
  #peek(length: number): Uint8Array {
    if (this.#chunks[0]!.length < length) {
      const joined = new Uint8Array(this.#buffered);
      let offset = 0;
      for (const chunk of this.#chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      this.#chunks = [joined];
    }
    return this.#chunks[0]!.subarray(0, length);
  }

  #consume(length: number): void {
    this.#buffered -= length;
    while (length > 0) {
      const first = this.#chunks[0]!;
      if (first.length <= length) {
        this.#chunks.shift();
        length -= first.length;
      } else {
        this.#chunks[0] = first.subarray(length);
        length = 0;
      }
    }
  }
}
