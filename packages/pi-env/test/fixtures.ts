import { assert, assertEquals, assertGreater, assertObjectMatch, assertRejects } from "@std/assert";
import type { EnvConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { Connection, DaemonRelay, type EnvLinkHandlers } from "../src/index.ts";

export const assertions: EnvConformanceAssertions = {
  ok: (value, message) => assert(value, message),
  strictEqual: (actual, expected) => assertEquals(actual, expected),
  deepEqual: (actual, expected) => assertEquals(actual, expected),
  partialDeepEqual: (actual, expected) =>
    assertObjectMatch(
      // SAFETY: conformance cases only compare record-shaped results partially.
      // deno-lint-ignore openorb/no-unsafe-dictionary-type
      actual as Record<PropertyKey, unknown>,
      // SAFETY: as above; `assertObjectMatch` accepts only records.
      // deno-lint-ignore openorb/no-unsafe-dictionary-type
      expected as Record<PropertyKey, unknown>,
    ),
  greaterThan: (actual, expected) => assertGreater(actual, expected),
  rejects: async (operation, messageIncludes) => {
    await assertRejects(() => operation, Error, messageIncludes);
  },
};

/** A started daemon process, wherever it runs. */
export interface DaemonProcess {
  readonly token: string;
  write(bytes: Uint8Array): void;
  end(): void;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly exited: Promise<unknown>;
}

/**
 * Joins a client `Connection` to a daemon through a `DaemonRelay` and an in-memory link that
 * delivers one frame per message asynchronously, as a WebSocket does.
 */
export function relayedConnection(start: () => Promise<DaemonProcess>): Connection {
  return new Connection({
    open: async (handlers: EnvLinkHandlers) => {
      const daemon = await start();
      let open = true;
      const close = (reason: string) => {
        if (!open) return;
        open = false;
        clearInterval(timer);
        daemon.end();
        handlers.closed(reason);
      };
      const relay = new DaemonRelay(daemon.token, {
        toDaemon: (bytes) => daemon.write(bytes),
        toLink: (frame) => queueMicrotask(() => open && handlers.frame(frame.slice())),
      });
      const timer = setInterval(() => {
        try {
          relay.pingDaemon();
        } catch (error) {
          close(String(error));
        }
      }, 5000);
      void (async () => {
        try {
          for await (const chunk of daemon.stdout) relay.fromDaemon(chunk);
          close("daemon output ended");
        } catch (error) {
          close(String(error));
        }
      })();
      return {
        send: (frame) => queueMicrotask(() => open && relay.fromLink(frame.slice())),
        close: () => close("client closed the link"),
      };
    },
  });
}
