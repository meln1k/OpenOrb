import type { EnvLink, EnvLinkHandlers } from "@openorb/pi-env";
import { Schema } from "effect";
import type { EnvironmentLinkHost } from "./environment/runner-provider.ts";

const LINK_ATTACH_TIMEOUT_MS = 30_000;
const LINK_TAG = "link";
const ATTACH_REQUEST = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("attach"), token: Schema.String, nonce: Schema.String }),
);

export interface LinkAttachment {
  readonly phase: "pending" | "attached";
  readonly runnerId?: string;
}

export interface SessionWebSocket {
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: LinkAttachment): void;
  /** Returns what `serializeAttachment` stored; a Session only stores link attachments. */
  deserializeAttachment(): LinkAttachment | null;
}

export interface LinkSockets {
  acceptWebSocket(socket: SessionWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): SessionWebSocket[];
}

/** Who may attach: the runner placement this Session's environment lives on. */
export interface LinkAuthority {
  readonly runnerId: string;
  readonly workspaceId: string;
  readonly authenticate: (
    token: string,
  ) => Promise<{ readonly id: string; readonly workspaceId: string } | null>;
}

type PendingLink = {
  readonly resolve: (link: EnvLink) => void;
  readonly reject: (error: Error) => void;
};

export class LinkAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkAttachError";
  }
}

/**
 * Environment Links as hibernatable WebSockets (ADR 0005). The runner dials, then authenticates
 * in-band with its token and a one-time nonce. The current link is found again after hibernation
 * through its socket attachment.
 */
export class EnvironmentLinks {
  readonly #sockets: LinkSockets;
  readonly #pending = new Map<string, PendingLink>();
  #routed: EnvLinkHandlers | undefined;

  constructor(sockets: LinkSockets) {
    this.#sockets = sockets;
  }

  host(): EnvironmentLinkHost {
    return {
      current: () => {
        const socket = this.#attached();
        return socket === undefined ? undefined : socketLink(socket);
      },
      expect: (nonce, signal) =>
        new Promise<EnvLink>((resolve, reject) => {
          const fail = (error: Error) => {
            clearTimeout(timer);
            this.#pending.delete(nonce);
            reject(error);
          };
          const timer = setTimeout(
            () => fail(new LinkAttachError("The runner did not dial the Environment Link.")),
            LINK_ATTACH_TIMEOUT_MS,
          );
          signal.addEventListener(
            "abort",
            () => fail(new LinkAttachError("Environment Link attach cancelled.")),
            { once: true },
          );
          this.#pending.set(nonce, {
            resolve: (link) => {
              clearTimeout(timer);
              resolve(link);
            },
            reject: fail,
          });
        }),
      route: (handlers) => {
        this.#routed = handlers;
      },
    };
  }

  /** Accepts the runner's upgrade; authentication follows in its first message. */
  accept(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server: SessionWebSocket = pair[1];
    this.#sockets.acceptWebSocket(server, [LINK_TAG]);
    server.serializeAttachment({ phase: "pending" });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async message(
    socket: SessionWebSocket,
    message: string | ArrayBuffer,
    authority: LinkAuthority | undefined,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment();
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
    const pending = request._tag === "Some" ? this.#pending.get(request.value.nonce) : undefined;
    if (request._tag === "None" || pending === undefined || authority === undefined) {
      socket.close(4401, "Unknown attach request.");
      return;
    }
    this.#pending.delete(request.value.nonce);
    const runner = await authority.authenticate(request.value.token);
    if (runner?.id !== authority.runnerId || runner.workspaceId !== authority.workspaceId) {
      socket.close(4401, "The runner is not authorized for this session.");
      pending.reject(new LinkAttachError("The runner failed Environment Link authentication."));
      return;
    }
    // One current link: a newer attach replaces any previous one.
    for (const other of this.#sockets.getWebSockets(LINK_TAG)) {
      if (other !== socket && other.deserializeAttachment()?.phase === "attached") {
        other.close(1000, "Replaced by a newer link.");
      }
    }
    socket.serializeAttachment({ phase: "attached", runnerId: runner.id });
    socket.send("attached");
    pending.resolve(socketLink(socket));
  }

  closed(socket: SessionWebSocket, reason: string): void {
    if (socket.deserializeAttachment()?.phase !== "attached") return;
    this.#routed?.closed(reason || "The Environment Link closed.");
  }

  closeAll(code: number, reason: string): void {
    for (const socket of this.#sockets.getWebSockets(LINK_TAG)) socket.close(code, reason);
    this.#routed?.closed(reason);
  }

  #attached(): SessionWebSocket | undefined {
    return this.#sockets
      .getWebSockets(LINK_TAG)
      .find((candidate) => candidate.deserializeAttachment()?.phase === "attached");
  }
}

function socketLink(socket: SessionWebSocket): EnvLink {
  return {
    send: (frame) => socket.send(frame),
    close: () => socket.close(1000, "The session closed the link."),
  };
}
