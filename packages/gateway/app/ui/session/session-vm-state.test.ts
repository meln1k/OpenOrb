import { assertEquals } from "@std/assert";

import {
  initialSessionVmPhase,
  isSessionVmTransitioning,
  sessionVmPhaseForStage,
  sessionVmPhaseLabel,
} from "./session-vm-state.ts";

Deno.test("Gondolin VM phases distinguish active, sleeping, and lifecycle transitions", () => {
  assertEquals(initialSessionVmPhase("ready"), "active");
  assertEquals(initialSessionVmPhase("stopped"), "sleeping");
  assertEquals(initialSessionVmPhase("offline"), "offline");
  assertEquals(sessionVmPhaseForStage("starting-vm"), "starting");
  assertEquals(sessionVmPhaseForStage("resuming"), "waking");
  assertEquals(sessionVmPhaseForStage("checkpointing"), "stopping");
  assertEquals(sessionVmPhaseForStage("running"), "active");
  assertEquals(sessionVmPhaseForStage("stopped"), "sleeping");
  assertEquals(isSessionVmTransitioning("waking"), true);
  assertEquals(isSessionVmTransitioning("active"), false);
  assertEquals(sessionVmPhaseLabel("sleeping"), "Sleeping");
});
