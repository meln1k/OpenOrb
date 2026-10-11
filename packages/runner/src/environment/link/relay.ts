import { DaemonRelay } from "@openorb/pi-env";
import { Effect, Schedule } from "effect";
import type { EnvironmentDaemon } from "../agent-environment.ts";

/** The runner's end of one Environment Link. Each message is exactly one protocol frame. */
export interface EnvironmentLinkEnd {
  readonly send: (frame: Uint8Array) => void;
  readonly messages: AsyncIterable<Uint8Array>;
  readonly close: (reason: string) => void;
}

/**
 * Relays frames between a started Environment Daemon and one link until either side ends, then
 * closes both. Closing the daemon's stdin kills every process it started.
 */
export const relayEnvironmentDaemon = Effect.fn("relayEnvironmentDaemon")(function* (
  daemon: EnvironmentDaemon,
  link: EnvironmentLinkEnd,
) {
  const relay = new DaemonRelay(daemon.token, {
    toDaemon: (bytes) => daemon.write(bytes),
    toLink: (frame) => link.send(frame),
  });
  const daemonOutput = Effect.tryPromise(async () => {
    for await (const chunk of daemon.stdout) relay.fromDaemon(chunk);
    return "The Environment Daemon exited.";
  });
  const linkMessages = Effect.tryPromise(async () => {
    for await (const message of link.messages) relay.fromLink(message);
    return "The Environment Link closed.";
  });
  const keepalive = Effect.try(() => relay.pingDaemon()).pipe(
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.as("The Environment Daemon stopped answering."),
  );
  const reason = yield* Effect.raceAllFirst([daemonOutput, linkMessages, keepalive]).pipe(
    Effect.catch((error) => Effect.succeed(`Environment Link relay failed: ${error.message}`)),
    Effect.ensuring(daemon.close),
  );
  link.close(reason);
  return reason;
});
