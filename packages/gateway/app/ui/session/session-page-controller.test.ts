import { assertEquals } from "@std/assert";

import { SessionPageController } from "./session-page-controller.tsx";

Deno.test("session page controller publishes one lifecycle projection before session updates", () => {
  const controller = new SessionPageController("stopped", []);
  let observedState: string | undefined;
  controller.addEventListener("session", () => {
    observedState = controller.projection.sessionState;
  });

  controller.apply({
    type: "session.state",
    stage: "resuming",
    checkoutState: "available",
    issues: [],
  });

  assertEquals(observedState, "provisioning");
  assertEquals(controller.projection, {
    connectionInterrupted: false,
    sessionState: "provisioning",
    stage: "resuming",
    issues: [],
  });

  controller.setConnectionInterrupted(true);
  assertEquals(controller.projection.connectionInterrupted, true);
});

Deno.test("session page controller keeps failures visible across runner disconnects", () => {
  const controller = new SessionPageController("offline", []);
  assertEquals(controller.projection.connectionInterrupted, true);

  controller.apply({
    type: "session.state",
    stage: "failed",
    checkoutState: "unavailable",
    issues: [{
      category: "clone",
      severity: "warning",
      message: "Clone failed, but Pi remains available.",
      diagnostics: "fatal: repository unavailable",
      recovery: "none",
    }],
  });
  assertEquals(controller.projection.sessionState, "error");
  assertEquals(controller.projection.issues[0]?.category, "clone");

  controller.setConnectionInterrupted(false);
  assertEquals(controller.projection.connectionInterrupted, false);
  assertEquals(controller.projection.issues[0]?.diagnostics, "fatal: repository unavailable");
});
