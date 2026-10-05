import { assertEquals } from "@std/assert";
import {
  isSessionVmTransitioning,
  sessionVmPhase,
  sessionVmPhaseLabel,
} from "./session-vm-state.ts";
import { actionForState } from "./session-vm-control.tsx";

Deno.test("environment presentation uses its own lifecycle", () => {
  assertEquals(sessionVmPhase("starting"), "starting");
  assertEquals(sessionVmPhase("running"), "active");
  assertEquals(sessionVmPhase("stopped"), "sleeping");
  assertEquals(sessionVmPhase("stopping"), "stopping");
  assertEquals(sessionVmPhase(null), "offline");
  assertEquals(isSessionVmTransitioning("stopping"), true);
  assertEquals(isSessionVmTransitioning("active"), false);
  assertEquals(sessionVmPhaseLabel("sleeping"), "Sleeping");
});

Deno.test("Stop Session pauses a running agent even when its environment is stopped", () => {
  assertEquals(actionForState({ agentState: "running", environmentState: "stopped" }), "stop");
  assertEquals(actionForState({ agentState: "paused", environmentState: "stopping" }), undefined);
  assertEquals(actionForState({ agentState: "paused", environmentState: "stopped" }), "start");
});
