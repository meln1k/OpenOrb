import { test } from "vite-plus/test";
import { assertEquals } from "@jsr/std__assert";
import {
  type AgentEnvironmentCapabilities,
  receivesCredentials,
} from "../app/cells/session/environment/provider.ts";

const mediated: AgentEnvironmentCapabilities = {
  persistence: "root-disk",
  credentials: "mediated",
  hibernatableLink: true,
  git: true,
};
const optIn: AgentEnvironmentCapabilities = { ...mediated, credentials: "opt-in" };
const none: AgentEnvironmentCapabilities = { ...mediated, credentials: "none" };

test("credentials reach unmediated providers only with Guest Credential Opt-in", () => {
  assertEquals(receivesCredentials(mediated, false), true);
  assertEquals(receivesCredentials(optIn, false), false);
  assertEquals(receivesCredentials(optIn, true), true);
  // Providers without egress, such as the Sandbox, never receive them, even when opted in.
  assertEquals(receivesCredentials(none, true), false);
});
