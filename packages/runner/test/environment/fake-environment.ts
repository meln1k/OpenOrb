import { Effect } from "effect";
import type { AgentEnvironment } from "../../src/environment/agent-environment.ts";

/** A guest that records commands and stops; the Environment Daemon is not started. */
export class FakeEnvironment implements AgentEnvironment {
  commands: readonly string[][] = [];
  stops = 0;
  run: AgentEnvironment["run"] = (command) =>
    Effect.sync(() => {
      this.commands = [...this.commands, [...command]];
      return { exitCode: 0 };
    });
  startDaemon: AgentEnvironment["startDaemon"] = Effect.die("unexpected Environment Daemon start");
  stop = Effect.sync(() => {
    this.stops++;
  });
}
