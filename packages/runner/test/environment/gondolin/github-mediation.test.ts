import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Result } from "@openorb/result";

import {
  createOpenOrbGitHubVmOptions,
  type OpenOrbGitHubMediationOptions,
  type OpenOrbGitHubVmOptions,
} from "@/src/environment/gondolin/github-mediation.ts";

const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const MODIFIED_REPOSITORY_URL = "https://github.com/octocat/Hello-World.git";
const TOKEN = "github-test-token-4e63d197c57a";
const GIT_AUTHOR = { name: "OpenOrb User", email: "user@example.com" };

Deno.test("creates a fresh guest placeholder and a scoped Git credential helper", () => {
  const first = githubVmOptions({ repositoryUrl: REPOSITORY_URL, token: TOKEN });
  const second = githubVmOptions({ repositoryUrl: REPOSITORY_URL, token: TOKEN });
  const firstEnvironment = environmentOf(first.env);
  const secondEnvironment = environmentOf(second.env);
  const placeholder = firstEnvironment.GH_TOKEN;

  assert(placeholder, "expected a guest GH_TOKEN placeholder");
  assert(placeholder !== TOKEN, "the guest placeholder must not equal the real token");
  assert(placeholder !== secondEnvironment.GH_TOKEN, "each VM must receive a fresh placeholder");
  assert(
    !JSON.stringify(firstEnvironment).includes(TOKEN),
    "the VM environment contains the token",
  );
  assertEquals(firstEnvironment.GH_HOST, "github.com");
  assertEquals(firstEnvironment.GH_PROMPT_DISABLED, "1");
  assertEquals(firstEnvironment.GIT_TERMINAL_PROMPT, "0");
  assertEquals(firstEnvironment.GIT_CONFIG_COUNT, "6");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_0, "safe.directory");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_0, "/workspace");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_1, "safe.directory");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_1, "/workspace/*");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_2, "user.name");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_2, GIT_AUTHOR.name);
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_3, "user.email");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_3, GIT_AUTHOR.email);
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_4, `credential.${REPOSITORY_URL}.helper`);
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_4, "!gh auth git-credential");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_5, `credential.${REPOSITORY_URL}.useHttpPath`);
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_5, "true");
  assertEquals(first.allowWebSockets, false);
  assertEquals(first.dns, { mode: "synthetic" });
});

Deno.test("allows public HTTP and HTTPS while blocking private destination IPs", async () => {
  const options = githubVmOptions({ repositoryUrl: REPOSITORY_URL, token: TOKEN });

  for (
    const url of [
      "http://snapshot.debian.org/archive/debian/20260803T000000Z/dists/trixie/InRelease",
      "https://registry.npmjs.org/",
      "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip",
      "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
      "https://api.github.com/repos/octocat/Hello-World",
    ] as const
  ) {
    assert(await requestAllowed(options, "GET", url), `expected GET ${url} to be allowed`);
  }

  const ipPolicy = options.httpHooks?.isIpAllowed;
  assert(ipPolicy);
  assert(
    await ipPolicy({
      hostname: "snapshot.debian.org",
      ip: "151.101.2.132",
      family: 4,
      port: 80,
      protocol: "http",
    }),
  );
  for (
    const [ip, family] of [
      ["127.0.0.1", 4],
      ["10.0.0.1", 4],
      ["172.16.0.1", 4],
      ["192.168.1.1", 4],
      ["169.254.169.254", 4],
      ["::1", 6],
      ["fc00::1", 6],
      ["fe80::1", 6],
    ] as const
  ) {
    assert(
      !(await ipPolicy({
        hostname: "attacker.example",
        ip,
        family,
        port: 443,
        protocol: "https",
      })),
      `expected ${ip} to be blocked`,
    );
  }
});

Deno.test("substitutes the placeholder only for allowed GitHub hosts", async () => {
  const options = githubVmOptions({ repositoryUrl: REPOSITORY_URL, token: TOKEN });
  const environment = environmentOf(options.env);
  const placeholder = environment.GH_TOKEN;
  assert(placeholder);

  const request = new Request(`${REPOSITORY_URL}/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${btoa(`x-access-token:${placeholder}`)}` },
  });
  const mediated = await options.httpHooks?.onRequest?.(request);
  assert(mediated instanceof Request);
  const authorization = mediated.headers.get("authorization");
  assert(authorization);
  assert(authorization.startsWith("Basic "));
  const decoded = atob(authorization.slice("Basic ".length));
  assert(decoded === `x-access-token:${TOKEN}`, "the allowed Basic credential was not mediated");

  const otherRepository = await options.httpHooks?.onRequest?.(
    new Request("https://api.github.com/repos/octocat/Hello-World", {
      headers: { authorization: `Bearer ${placeholder}` },
    }),
  );
  assert(otherRepository instanceof Request);
  assertEquals(otherRepository.headers.get("authorization"), `Bearer ${TOKEN}`);

  await assertRejects(
    async () => {
      await options.httpHooks?.onRequest?.(
        new Request("https://example.com/", {
          headers: { authorization: `Bearer ${placeholder}` },
        }),
      );
    },
    Error,
    "not allowed for host",
  );
});

Deno.test("supports an unauthenticated public policy without exposing GH_TOKEN", () => {
  const options = githubVmOptions({ repositoryUrl: REPOSITORY_URL });
  const environment = environmentOf(options.env);
  assertEquals(environment.GH_TOKEN, undefined);
  assertEquals(environment.GIT_CONFIG_COUNT, "4");
  assertEquals(environment.GIT_CONFIG_KEY_0, "safe.directory");
  assertEquals(environment.GIT_CONFIG_VALUE_0, "/workspace");
  assertEquals(environment.GIT_CONFIG_KEY_1, "safe.directory");
  assertEquals(environment.GIT_CONFIG_VALUE_1, "/workspace/*");
  assertEquals(environment.GIT_CONFIG_KEY_2, "user.name");
  assertEquals(environment.GIT_CONFIG_VALUE_2, GIT_AUTHOR.name);
  assertEquals(environment.GIT_CONFIG_KEY_3, "user.email");
  assertEquals(environment.GIT_CONFIG_VALUE_3, GIT_AUTHOR.email);
  assertEquals(environment.GIT_CONFIG_KEY_4, undefined);
});

Deno.test("credential helper remains scoped to the canonical repository after origin changes", () => {
  const environment = environmentOf(
    githubVmOptions({ repositoryUrl: REPOSITORY_URL, token: TOKEN }).env,
  );
  assertEquals(environment.GIT_CONFIG_KEY_4, `credential.${REPOSITORY_URL}.helper`);
  assertEquals(environment.GIT_CONFIG_KEY_5, `credential.${REPOSITORY_URL}.useHttpPath`);
  assert(
    !Object.values(environment).some((value) => value.includes(MODIFIED_REPOSITORY_URL)),
    "a modified origin received a credential-helper configuration",
  );
});

Deno.test("rejects non-canonical repository URLs and invalid tokens", () => {
  for (
    const repositoryUrl of [
      "meln1k/openorb",
      "http://github.com/meln1k/openorb.git",
      "https://github.com/meln1k/openorb",
      "https://github.com/meln1k/openorb.git/",
      "https://github.com/meln1k/openorb.git?ref=main",
      "https://github.com/meln1k/openorb.git#readme",
      "https://github.com/meln1k/openorb/extra.git",
      "https://github.com/meln1k/%6fpenorb.git",
      "https://api.github.com/meln1k/openorb.git",
      "ssh://git@github.com/meln1k/openorb.git",
    ]
  ) {
    const repositoryError = failure(
      createOpenOrbGitHubVmOptions({ repositoryUrl, gitAuthor: GIT_AUTHOR }),
    );
    assertStringIncludes(
      repositoryError.message,
      "canonical https://github.com/OWNER/REPOSITORY.git",
    );
  }

  for (const token of ["", " token", "token ", "x".repeat(4097)]) {
    const tokenError = failure(
      createOpenOrbGitHubVmOptions({
        repositoryUrl: REPOSITORY_URL,
        gitAuthor: GIT_AUTHOR,
        token,
      }),
    );
    assertStringIncludes(tokenError.message, "non-empty trimmed value");
  }

  for (
    const gitAuthor of [
      { name: "", email: GIT_AUTHOR.email },
      { name: " OpenOrb User", email: GIT_AUTHOR.email },
      { name: GIT_AUTHOR.name, email: "not-an-email" },
    ]
  ) {
    const authorError = failure(
      createOpenOrbGitHubVmOptions({ repositoryUrl: REPOSITORY_URL, gitAuthor }),
    );
    assertStringIncludes(authorError.message, "Git author");
  }
});

function githubVmOptions(
  options: Omit<OpenOrbGitHubMediationOptions, "gitAuthor">,
): OpenOrbGitHubVmOptions {
  return success(createOpenOrbGitHubVmOptions({ ...options, gitAuthor: GIT_AUTHOR }));
}

function success<T, E>(result: Result<T, E>): T {
  const [value, error] = result;
  if (error !== undefined) throw error;
  // SAFETY: The Result success variant always contains T when the error slot is undefined.
  return value as T;
}

function failure<T, E>(result: Result<T, E>): E {
  const [, error] = result;
  if (error === undefined) throw new Error("Expected operation to fail.");
  return error;
}

function environmentOf(
  environment: string[] | Record<string, string> | undefined,
): Record<string, string> {
  assert(environment && !Array.isArray(environment));
  return environment;
}

async function requestAllowed(
  options: OpenOrbGitHubVmOptions,
  method: string,
  url: string,
): Promise<boolean> {
  const policy = options.httpHooks?.isRequestAllowed;
  assert(policy);
  return await policy(new Request(url, { method }));
}
