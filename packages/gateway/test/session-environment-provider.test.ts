import { assertEquals } from "@std/assert";
import {
  type AgentEnvironmentCapabilities,
  DEFAULT_ENVIRONMENT_PROVIDER,
  permittedCredentials,
  resolveEnvironmentProvider,
} from "../app/cells/session/environment/provider.ts";

const mediated: AgentEnvironmentCapabilities = {
  persistence: "root-disk",
  egressSecretMediation: true,
  hibernatableLink: true,
};
const unmediated: AgentEnvironmentCapabilities = { ...mediated, egressSecretMediation: false };
const credentials = {
  githubToken: "gho_test",
  environmentSecrets: [{ name: "API_KEY", value: "secret" }],
};

Deno.test("Sessions without a provider choice use the default provider", () => {
  assertEquals(resolveEnvironmentProvider({}), DEFAULT_ENVIRONMENT_PROVIDER);
  assertEquals(resolveEnvironmentProvider({ workspace: "runner" }), "runner");
});

Deno.test("credentials reach unmediated providers only with Guest Credential Opt-in", () => {
  assertEquals(permittedCredentials(mediated, false, credentials), credentials);
  assertEquals(permittedCredentials(unmediated, false, credentials), {});
  assertEquals(permittedCredentials(unmediated, true, credentials), credentials);
});
