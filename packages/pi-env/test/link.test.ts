import { afterEach, test, vi } from "vite-plus/test";
import { assert, assertEquals, assertRejects, assertThrows } from "@jsr/std__assert";
import { isConnectionLost } from "@earendil-works/pi-env";
import {
  DaemonOutput,
  DaemonOutputError,
  DaemonRelay,
  type EnvLinkHandlers,
  LinkConnection,
  parseFrame,
  PING_FRAME,
  RelayError,
} from "../src/index.ts";

const encoder = new TextEncoder();

afterEach(() => vi.useRealTimers());

type JsonValue = string | number | boolean | readonly string[];
type JsonFields = Readonly<Record<string, JsonValue>>;

function encodeFrame(type: number, id: number, json: JsonFields, payload = new Uint8Array(0)) {
  const body = encoder.encode(JSON.stringify(json));
  const bytes = new Uint8Array(13 + body.length + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 9 + body.length + payload.length);
  view.setUint8(4, type);
  view.setUint32(5, id);
  view.setUint32(9, body.length);
  bytes.set(body, 13);
  bytes.set(payload, 13 + body.length);
  return bytes;
}

const HELLO = {
  protocol: 1,
  version: "1.1.0",
  os: "linux",
  arch: "x64",
  home: "/root",
  tmpdir: "/tmp",
  separator: "/",
  cwd: "/",
  pid: 1,
};

/** A scripted daemon that answers `hello` and records every frame the client sends. */
function scriptedLink() {
  const sent: ReturnType<typeof parseFrame>[] = [];
  let handlers: EnvLinkHandlers | undefined;
  let closed = false;
  const connection = new LinkConnection({
    open: (next) => {
      handlers = next;
      return Promise.resolve({
        send: (frame) => {
          const parsed = parseFrame(frame);
          sent.push(parsed);
          if (parsed?.json.op === "hello") {
            queueMicrotask(() => handlers?.frame(encodeFrame(2, parsed.id, HELLO)));
          }
        },
        close: () => (closed = true),
      });
    },
  });
  return {
    connection,
    sent,
    reply: (id: number, json: JsonFields) => handlers?.frame(encodeFrame(2, id, json)),
    drop: (reason: string) => handlers?.closed(reason),
    get closed() {
      return closed;
    },
  };
}

test("an idle connection sends no pings; requests in flight are pinged", async () => {
  vi.useFakeTimers();
  const link = scriptedLink();
  await link.connection.info();
  await vi.advanceTimersByTimeAsync(60_000);
  assertEquals(link.sent.filter((frame) => frame?.type === 6).length, 0);

  const pending = link.connection.request("lstat", { path: "/" });
  await vi.advanceTimersByTimeAsync(5_000);
  assertEquals(link.sent.filter((frame) => frame?.type === 6).length, 1);
  const request = link.sent.find((frame) => frame?.json.op === "lstat")!;
  link.reply(request.id, { kind: "directory" });
  assertEquals((await pending).json, { kind: "directory" });

  await vi.advanceTimersByTimeAsync(60_000);
  assertEquals(link.sent.filter((frame) => frame?.type === 6).length, 1);
});

test("a silent link fails requests in flight as lost", async () => {
  vi.useFakeTimers();
  const link = scriptedLink();
  await link.connection.info();
  const pending = link.connection.request("exec", { argv: ["/bin/sleep", "600"] });
  const rejected = assertRejects(() => pending);
  await vi.advanceTimersByTimeAsync(36_000);
  const error = await rejected;
  assert(isConnectionLost(error));
  assert(link.closed);
});

test("replies that match no request of this connection are ignored", async () => {
  const link = scriptedLink();
  await link.connection.info();
  const pending = link.connection.request("lstat", { path: "/" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = link.sent.find((frame) => frame?.json.op === "lstat")!;
  link.reply(request.id + 1000, { stale: true });
  link.reply(request.id, { kind: "file" });
  assertEquals((await pending).json, { kind: "file" });
});

test("request ids start at a random value so a rehydrated connection skips stale replies", async () => {
  const first = scriptedLink();
  const second = scriptedLink();
  await first.connection.info();
  await second.connection.info();
  assert(first.sent[0]!.id !== second.sent[0]!.id);
});

test("a closed link fails requests in flight and reconnects on the next request", async () => {
  const link = scriptedLink();
  await link.connection.info();
  const pending = link.connection.request("lstat", { path: "/" });
  link.drop("socket closed");
  assert(isConnectionLost(await assertRejects(() => pending)));
  await link.connection.info();
  assertEquals(link.sent.filter((frame) => frame?.json.op === "hello").length, 2);
});

test("daemon output skips noise before the sync line and splits frames across chunks", () => {
  const noise: string[] = [];
  const output = new DaemonOutput("abc", (text) => noise.push(text));
  const first = encodeFrame(2, 7, { ok: true }, new Uint8Array([1, 2, 3]));
  const second = encodeFrame(4, 7, { kind: "output" });
  const stream = new Uint8Array([...encoder.encode("motd\nPI-ENV abc\n"), ...first, ...second]);
  const frames = [
    ...output.push(stream.subarray(0, 8)),
    ...output.push(stream.subarray(8, 30)),
    ...output.push(stream.subarray(30)),
  ];
  assertEquals(noise, ["motd"]);
  assertEquals(frames, [first, second]);
});

test("daemon output rejects frames with impossible lengths", () => {
  const output = new DaemonOutput("abc");
  assertThrows(
    () => output.push(new Uint8Array([...encoder.encode("PI-ENV abc\n"), 0, 0, 0, 1, 0])),
    DaemonOutputError,
  );
});

test("the relay answers pings locally and forwards everything else", () => {
  const toDaemon: Uint8Array[] = [];
  const toLink: Uint8Array[] = [];
  const relay = new DaemonRelay("abc", {
    toDaemon: (bytes) => toDaemon.push(bytes),
    toLink: (frame) => toLink.push(frame),
  });
  const request = encodeFrame(1, 9, { op: "lstat", path: "/" });
  const result = encodeFrame(2, 9, { kind: "directory" });

  relay.fromLink(PING_FRAME);
  relay.fromLink(request);
  relay.fromDaemon(new Uint8Array([...encoder.encode("PI-ENV abc\n"), ...PING_FRAME, ...result]));

  assertEquals(toDaemon, [request]);
  assertEquals(toLink, [PING_FRAME, result]);
});

test("the relay refuses link messages that are not exactly one frame", () => {
  const relay = new DaemonRelay("abc", { toDaemon: () => {}, toLink: () => {} });
  const frame = encodeFrame(1, 1, { op: "lstat" });
  assertThrows(() => relay.fromLink(new Uint8Array([...frame, ...frame])), RelayError);
  assertThrows(() => relay.fromLink(frame.subarray(0, 12)), RelayError);
});

test("the relay keeps the daemon alive and notices when it goes silent", () => {
  const toDaemon: Uint8Array[] = [];
  const relay = new DaemonRelay("abc", {
    toDaemon: (bytes) => toDaemon.push(bytes),
    toLink: () => {},
  });
  relay.pingDaemon();
  assertEquals(toDaemon, [PING_FRAME]);
  assertThrows(() => relay.pingDaemon(Date.now() + 31_000), RelayError);
});
