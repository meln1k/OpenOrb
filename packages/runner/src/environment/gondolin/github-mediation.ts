import { createHttpHooks, type VMOptions } from "@earendil-works/gondolin";
import { err, ok, type Result, trySync } from "@openorb/result";

const GITHUB_HOST = "github.com";
const GITHUB_API_HOST = "api.github.com";
const OPENORB_WORKSPACE = "/workspace";
const OPENORB_NESTED_WORKSPACE_REPOSITORIES = "/workspace/*";
const GITHUB_OWNER_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export interface OpenOrbGitHubMediationOptions {
  repositoryUrl: string;
  token?: string;
}

export type OpenOrbGitHubVmOptions = Pick<
  VMOptions,
  "allowWebSockets" | "dns" | "env" | "httpHooks"
>;

export function createOpenOrbGitHubVmOptions(
  options: OpenOrbGitHubMediationOptions,
): Result<OpenOrbGitHubVmOptions, GitHubMediationError> {
  const [, repositoryError] = validateCanonicalGitHubRepository(options.repositoryUrl);
  if (repositoryError !== undefined) return err(repositoryError);
  const token = options.token;
  if (
    token !== undefined && (token.length === 0 || token.length > 4096 || token.trim() !== token)
  ) {
    return err(
      new GitHubMediationError(
        "The GitHub token must be a non-empty trimmed value of at most 4096 characters.",
        undefined,
      ),
    );
  }

  const [hooks, hooksError] = trySync(
    () =>
      createHttpHooks({
        blockInternalRanges: true,
        ...(token === undefined ? {} : {
          secrets: {
            GH_TOKEN: {
              hosts: [GITHUB_HOST, GITHUB_API_HOST],
              value: token,
            },
          },
        }),
      }),
    (cause) => new GitHubMediationError("GitHub request mediation could not be created.", cause),
  );
  if (hooksError !== undefined) return err(hooksError);
  const { env: secretEnvironment, httpHooks } = hooks;

  const env = {
    ...secretEnvironment,
    GH_HOST: GITHUB_HOST,
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_COUNT: token === undefined ? "2" : "4",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: OPENORB_WORKSPACE,
    GIT_CONFIG_KEY_1: "safe.directory",
    GIT_CONFIG_VALUE_1: OPENORB_NESTED_WORKSPACE_REPOSITORIES,
    GIT_TERMINAL_PROMPT: "0",
    ...(token === undefined ? {} : {
      GIT_CONFIG_KEY_2: `credential.${options.repositoryUrl}.helper`,
      GIT_CONFIG_VALUE_2: "!gh auth git-credential",
      GIT_CONFIG_KEY_3: `credential.${options.repositoryUrl}.useHttpPath`,
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

function validateCanonicalGitHubRepository(
  repositoryUrl: string,
): Result<void, GitHubMediationError> {
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

export class GitHubMediationError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "GitHubMediationError";
  }
}

function invalidRepositoryUrl(cause?: unknown): GitHubMediationError {
  return new GitHubMediationError(
    "The GitHub repository URL must use the canonical https://github.com/OWNER/REPOSITORY.git form.",
    cause,
  );
}
