import type { EnvLink, EnvLinkHandlers } from "@openorb/pi-env";
import { Schema } from "effect";
import type { EnvironmentHost, HostWebSocket } from "../environment.ts";

const LINK_ATTACH_TIMEOUT_MS = 30_000;
const LINK_TAG = "link";
const ATTACH_REQUEST = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("attach"), token: Schema.String }),
);
const ATTACHMENT = Schema.Struct({
  phase: Schema.Literals(["pending", "attached"]),
  runnerId: Schema.optionalKey(Schema.String),
});
type LinkAttachment = typeof ATTACHMENT.Type;

/** Who may attach: the runner placement this Session's environment lives on. */
export interface LinkAuthority {
  readonly runnerId: string;
  readonly workspaceId: string;
  readonly authenticate: (
    token: string,
  ) => Promise<{ readonly id: string; readonly workspaceId: string } | null>;
}

type LinkWaiter = (link: EnvLink) => void;

export class LinkAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkAttachError";
  }
}

/**
 * Environment Links as hibernatable WebSockets (ADR 0005). The runner dials whenever the
 * environment runs, then authenticates in-band with its token. The current link is found again
 * after hibernation through its socket attachment.
 */
export class EnvironmentLinks {
  readonly #host: Pick<EnvironmentHost, "acceptWebSocket" | "getWebSockets">;
  readonly #authority: LinkAuthority;
  readonly #waiters = new Set<LinkWaiter>();
  #routed: EnvLinkHandlers | undefined;

  constructor(
    host: Pick<EnvironmentHost, "acceptWebSocket" | "getWebSockets">,
    authority: LinkAuthority,
  ) {
    this.#host = host;
    this.#authority = authority;
  }

  /** An attached link that survived hibernation, if any. */
  current(): EnvLink | undefined {
    const socket = this.#attached();
    return socket === undefined ? undefined : socketLink(socket);
  }

  /** The current link, or the next one the runner dials, within a bounded wait. */
  next(signal: AbortSignal): Promise<EnvLink> {
    const current = this.current();
    if (current !== undefined) return Promise.resolve(current);
    return new Promise<EnvLink>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        signal.removeEventListener("abort", aborted);
      };
      const waiter: LinkWaiter = (link) => {
        settle();
        resolve(link);
      };
      const aborted = () => {
        settle();
        reject(new LinkAttachError("Environment Link attach cancelled."));
      };
      const timer = setTimeout(() => {
        settle();
        reject(new LinkAttachError("The runner did not dial the Environment Link."));
      }, LINK_ATTACH_TIMEOUT_MS);
      signal.addEventListener("abort", aborted, { once: true });
      this.#waiters.add(waiter);
    });
  }

  /** Routes frames and closure of the current link to `handlers`. */
  route(handlers: EnvLinkHandlers): void {
    this.#routed = handlers;
  }

  /** Accepts the runner's upgrade; authentication follows in its first message. */
  accept(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server: HostWebSocket = pair[1];
    this.#host.acceptWebSocket(server, [LINK_TAG]);
    server.serializeAttachment({ phase: "pending" } satisfies LinkAttachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async message(socket: HostWebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(socket);
    if (attachment?.phase === "attached") {
      // Text messages are link control; `ping` is answered by the platform.
      if (message instanceof ArrayBuffer) this.#routed?.frame(new Uint8Array(message));
      return;
    }
    if (attachment?.phase !== "pending" || message instanceof ArrayBuffer) {
      socket.close(4400, "Expected an attach request.");
      return;
    }
    const request = Schema.decodeUnknownOption(ATTACH_REQUEST)(message);
    if (request._tag === "None") {
      socket.close(4400, "Expected an attach request.");
      return;
    }
    const authority = this.#authority;
    const runner = await authority.authenticate(request.value.token);
    if (runner?.id !== authority.runnerId || runner.workspaceId !== authority.workspaceId) {
      socket.close(4401, "The runner is not authorized for this session.");
      return;
    }
    // One current link: a newer attach replaces any previous one.
    for (const other of this.#host.getWebSockets(LINK_TAG)) {
      if (other !== socket && attachmentOf(other)?.phase === "attached") {
        other.close(1000, "Replaced by a newer link.");
      }
    }
    socket.serializeAttachment({ phase: "attached", runnerId: runner.id } satisfies LinkAttachment);
    socket.send("attached");
    const link = socketLink(socket);
    for (const waiter of this.#waiters) waiter(link);
  }

  closed(socket: HostWebSocket, reason: string): void {
    if (attachmentOf(socket)?.phase !== "attached") return;
    this.#routed?.closed(reason || "The Environment Link closed.");
  }

  closeAll(code: number, reason: string): void {
    for (const socket of this.#host.getWebSockets(LINK_TAG)) socket.close(code, reason);
    this.#routed?.closed(reason);
  }

  #attached(): HostWebSocket | undefined {
    return this.#host
      .getWebSockets(LINK_TAG)
      .find((candidate) => attachmentOf(candidate)?.phase === "attached");
  }
}

function attachmentOf(socket: HostWebSocket): LinkAttachment | undefined {
  const decoded = Schema.decodeUnknownOption(ATTACHMENT)(socket.deserializeAttachment());
  return decoded._tag === "Some" ? decoded.value : undefined;
}

function socketLink(socket: HostWebSocket): EnvLink {
  return {
    send: (frame) => socket.send(frame),
    close: () => socket.close(1000, "The session closed the link."),
  };
}
