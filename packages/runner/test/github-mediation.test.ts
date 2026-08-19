import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Result } from "@openorb/result";

import {
  createOpenOrbGitHubVmOptions,
  type OpenOrbGitHubMediationOptions,
  type OpenOrbGitHubVmOptions,
} from "@/src/github-mediation.ts";

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
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_2, "credential.https://github.com.helper");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_2, "!gh auth git-credential");
  assertEquals(firstEnvironment.GIT_CONFIG_KEY_3, "credential.https://github.com.useHttpPath");
  assertEquals(firstEnvironment.GIT_CONFIG_VALUE_3, "true");
  assertEquals(first.allowWebSockets, false);
  assertEquals(first.dns, { mode: "synthetic" });
});

Deno.test("allows only the configured GitHub repository smart-HTTP and metadata paths", async () => {
  const options = githubVmOptions({ repositoryUrl: REPOSITORY_URL, token: TOKEN });

  for (
    const [method, url] of [
      ["GET", `${REPOSITORY_URL}/info/refs?service=git-upload-pack`],
      ["POST", `${REPOSITORY_URL}/git-upload-pack`],
      ["GET", `${REPOSITORY_URL}/info/refs?service=git-receive-pack`],
      ["POST", `${REPOSITORY_URL}/git-receive-pack`],
      ["GET", "https://api.github.com/repos/meln1k/openorb"],
    ] as const
  ) {
    assert(await requestAllowed(options, method, url), `expected ${method} ${url} to be allowed`);
  }

  for (
    const [method, url] of [
      ["GET", "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack"],
      ["GET", `${REPOSITORY_URL}/info/refs`],
      ["GET", `${REPOSITORY_URL}/info/refs?service=git-upload-pack&extra=1`],
      ["POST", `${REPOSITORY_URL}/info/refs?service=git-upload-pack`],
      ["GET", `${REPOSITORY_URL}/git-upload-pack`],
      ["POST", `${REPOSITORY_URL}/objects/pack`],
      ["GET", "https://api.github.com/repos/octocat/Hello-World"],
      ["GET", "https://api.github.com/repos/meln1k/openorb/issues"],
      ["POST", "https://api.github.com/repos/meln1k/openorb"],
      ["GET", "https://api.github.com/repos/meln1k/openorb?ref=main"],
      ["GET", "https://example.com/meln1k/openorb.git/info/refs?service=git-upload-pack"],
      ["GET", "http://github.com/meln1k/openorb.git/info/refs?service=git-upload-pack"],
      ["GET", "https://github.com:8443/meln1k/openorb.git/info/refs?service=git-upload-pack"],
      ["GET", "https://user@github.com/meln1k/openorb.git/info/refs?service=git-upload-pack"],
    ] as const
  ) {
    assert(!(await requestAllowed(options, method, url)), `expected ${method} ${url} to be denied`);
  }
});

Deno.test("substitutes the placeholder only in allowed GitHub authorization headers", async () => {
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

Deno.test("denies redirect targets outside the configured repository endpoint", async () => {
  const options = githubVmOptions({ repositoryUrl: REPOSITORY_URL, token: TOKEN });
  for (
    const target of [
      "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
      "https://api.github.com/repos/meln1k/openorb/releases",
      "https://objects.githubusercontent.com/archive",
      "http://github.com/meln1k/openorb.git/info/refs?service=git-upload-pack",
    ]
  ) {
    assert(
      !(await requestAllowed(options, "GET", target)),
      `redirect target was allowed: ${target}`,
    );
  }
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
