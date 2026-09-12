import { createHttpHooks, type VMOptions } from "@earendil-works/gondolin";
import type { SessionEnvironmentSecret } from "@openorb/protocol/runner-api";
import { err, ok, type Result, trySync } from "@openorb/result";

const GITHUB_HOST = "github.com";
const GITHUB_API_HOST = "api.github.com";
const GITHUB_OWNER_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export interface OpenOrbGitHubMediationOptions {
  repositoryUrl: string;
  gitAuthor: {
    readonly name: string;
    readonly email: string;
  };
  token?: string;
}

export interface OpenOrbNetworkMediationOptions {
  readonly github?: OpenOrbGitHubMediationOptions;
  readonly environmentSecrets?: readonly SessionEnvironmentSecret[];
}

export type OpenOrbNetworkVmOptions = Pick<
  VMOptions,
  "allowWebSockets" | "dns" | "env" | "httpHooks"
>;

export function createOpenOrbNetworkVmOptions(
  options: OpenOrbNetworkMediationOptions,
): Result<OpenOrbNetworkVmOptions, NetworkMediationError> {
  const github = options.github;
  if (github !== undefined) {
    const [, repositoryError] = validateCanonicalGitHubRepository(github.repositoryUrl);
    if (repositoryError !== undefined) return err(repositoryError);
    const authorError = validateGitAuthor(github.gitAuthor);
    if (authorError !== undefined) return err(authorError);
  }
  const token = github?.token;
  if (
    token !== undefined && (token.length === 0 || token.length > 4096 || token.trim() !== token)
  ) {
    return err(
      new NetworkMediationError(
        "The GitHub token must be a non-empty trimmed value of at most 4096 characters.",
        undefined,
      ),
    );
  }

  const secrets = Object.fromEntries([
    ...(token === undefined
      ? []
      : [[GH_TOKEN_ENVIRONMENT_NAME, { hosts: [GITHUB_HOST, GITHUB_API_HOST], value: token }]]),
    ...(options.environmentSecrets?.map((secret) =>
      [
        secret.name,
        { hosts: secret.allowedHosts ?? ["*"], value: secret.value },
      ] as const
    ) ?? []),
  ]);
  const [hooks, hooksError] = trySync(
    () =>
      createHttpHooks({
        blockInternalRanges: true,
        ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
      }),
    (cause) => new NetworkMediationError("Network request mediation could not be created.", cause),
  );
  if (hooksError !== undefined) return err(hooksError);
  const { env: secretEnvironment, httpHooks } = hooks;

  const env = {
    ...secretEnvironment,
    ...(github === undefined ? {} : {
      GH_HOST: GITHUB_HOST,
      GH_PROMPT_DISABLED: "1",
      GIT_CONFIG_COUNT: token === undefined ? "2" : "4",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: github.gitAuthor.name,
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: github.gitAuthor.email,
      GIT_TERMINAL_PROMPT: "0",
    }),
    ...(token === undefined || github === undefined ? {} : {
      GIT_CONFIG_KEY_2: `credential.${github.repositoryUrl}.helper`,
      GIT_CONFIG_VALUE_2: "!gh auth git-credential",
      GIT_CONFIG_KEY_3: `credential.${github.repositoryUrl}.useHttpPath`,
      GIT_CONFIG_VALUE_3: "true",
    }),
  } satisfies Record<string, string>;

  return ok({
    allowWebSockets: false,
    dns: { mode: "synthetic" },
    env,
    httpHooks,
  });
}

function validateGitAuthor(
  author: OpenOrbGitHubMediationOptions["gitAuthor"],
): NetworkMediationError | undefined {
  if (
    author.name.trim() !== author.name || author.name.length === 0 || author.name.length > 200 ||
    author.name.includes("\0")
  ) {
    return new NetworkMediationError(
      "The Git author name must be a non-empty trimmed value of at most 200 characters.",
      undefined,
    );
  }
  if (
    author.email.trim() !== author.email || author.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(author.email)
  ) {
    return new NetworkMediationError("Expected a valid Git author email.", undefined);
  }
  return undefined;
}

function validateCanonicalGitHubRepository(
  repositoryUrl: string,
): Result<void, NetworkMediationError> {
  const [url, urlError] = trySync(
    () => new URL(repositoryUrl),
    (cause) => invalidRepositoryUrl(cause),
  );
  if (urlError !== undefined) return err(urlError);
  if (
    url.protocol !== "https:" ||
    url.hostname !== GITHUB_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith(".git")
  ) {
    return err(invalidRepositoryUrl());
  }

  const parts = url.pathname.slice(1, -4).split("/");
  if (parts.length !== 2) return err(invalidRepositoryUrl());
  const [owner, name] = parts;
  if (
    !owner ||
    !name ||
    !GITHUB_OWNER_PATTERN.test(owner) ||
    !GITHUB_REPOSITORY_PATTERN.test(name) ||
    name === "." ||
    name === ".." ||
    repositoryUrl !== `https://${GITHUB_HOST}/${owner}/${name}.git`
  ) {
    return err(invalidRepositoryUrl());
  }

  return ok(undefined);
}

export class NetworkMediationError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "NetworkMediationError";
  }
}

function invalidRepositoryUrl(cause?: unknown): NetworkMediationError {
  return new NetworkMediationError(
    "The GitHub repository URL must use the canonical https://github.com/OWNER/REPOSITORY.git form.",
    cause,
  );
}

const GH_TOKEN_ENVIRONMENT_NAME = "GH_TOKEN";
