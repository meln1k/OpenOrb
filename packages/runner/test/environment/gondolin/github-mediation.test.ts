import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Result } from "@openorb/result";

import {
  createOpenOrbGitHubVmOptions,
  type OpenOrbGitHubMediationOptions,
  type OpenOrbGitHubVmOptions,
} from "@/src/environment/gondolin/github-mediation.ts";

const REPOSITORY_URL = "https://github.com/meln1k/openorb.git";
const TOKEN = "github-test-token-4e63d197c57a";

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
  assertEquals(firstEnvironment.GIT_CONFIG_COUNT, "4");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_0, "safe.directory");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_0, "/workspace");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_1, "safe.directory");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_1, "/workspace/*");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_2, `credential.${REPOSITORY_URL}.helper`);
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_2, "!gh auth git-credential");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_3, `credential.${REPOSITORY_URL}.useHttpPath`);
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_3, "true");
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
  assertEquals(environment.GIT_CONFIG_COUNT, "2");
  assertEquals(environment.GIT_CONFIG_KEY_0, "safe.directory");
  assertEquals(environment.GIT_CONFIG_VALUE_0, "/workspace");
  assertEquals(environment.GIT_CONFIG_KEY_1, "safe.directory");
  assertEquals(environment.GIT_CONFIG_VALUE_1, "/workspace/*");
  assertEquals(environment.GIT_CONFIG_KEY_2, undefined);
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
      createOpenOrbGitHubVmOptions({ repositoryUrl }),
    );
    assertStringIncludes(
      repositoryError.message,
      "canonical https://github.com/OWNER/REPOSITORY.git",
    );
  }

  for (const token of ["", " token", "token ", "x".repeat(4097)]) {
    const tokenError = failure(
      createOpenOrbGitHubVmOptions({ repositoryUrl: REPOSITORY_URL, token }),
    );
    assertStringIncludes(tokenError.message, "non-empty trimmed value");
  }
});

function githubVmOptions(options: OpenOrbGitHubMediationOptions): OpenOrbGitHubVmOptions {
  return success(createOpenOrbGitHubVmOptions(options));
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
