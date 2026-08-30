import { assertEquals } from "@std/assert";

import { SessionPageController } from "./session-page-controller.tsx";

Deno.test("session page controller publishes one lifecycle projection before session updates", () => {
  const controller = new SessionPageController("stopped");
  let observedState: string | undefined;
  controller.addEventListener("session", () => {
    observedState = controller.projection.sessionState;
  });

  controller.apply({
    type: "session.state",
    stage: "resuming",
    checkoutState: "available",
  });

  assertEquals(observedState, "provisioning");
  assertEquals(controller.projection, {
    connectionInterrupted: false,
    sessionState: "provisioning",
    stage: "resuming",
  });

  controller.setConnectionInterrupted(true);
  assertEquals(controller.projection.connectionInterrupted, true);
});
