import { test } from "vite-plus/test";
import { assertEquals } from "@jsr/std__assert";
import { type EnvironmentCapabilities, receivesCredentials } from "../src/environment.ts";

const mediated: EnvironmentCapabilities = { credentials: "mediated", git: true };
const optIn: EnvironmentCapabilities = { ...mediated, credentials: "opt-in" };
const none: EnvironmentCapabilities = { ...mediated, credentials: "none" };

test("credentials reach unmediated providers only with Guest Credential Opt-in", () => {
  assertEquals(receivesCredentials(mediated, false), true);
  assertEquals(receivesCredentials(optIn, false), false);
  assertEquals(receivesCredentials(optIn, true), true);
  // Providers without egress, such as the Sandbox, never receive them, even when opted in.
  assertEquals(receivesCredentials(none, true), false);
});
