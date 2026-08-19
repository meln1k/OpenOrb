import { createHttpHooks, type VMOptions } from "@earendil-works/gondolin";
import { err, ok, type Result, trySync } from "@openorb/result";

const GITHUB_HOST = "github.com";
const GITHUB_API_HOST = "api.github.com";
const OPENORB_WORKSPACE = "/workspace";
const OPENORB_NESTED_WORKSPACE_REPOSITORIES = "/workspace/*";
const GITHUB_OWNER_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GIT_SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

export interface OpenOrbGitHubMediationOptions {
  repositoryUrl: string;
  token?: string;
}

export type OpenOrbGitHubVmOptions = Pick<
  VMOptions,
  "allowWebSockets" | "dns" | "env" | "httpHooks"
>;

interface GitHubRepository {
  owner: string;
  name: string;
  gitPath: string;
  apiPath: string;
}

export function createOpenOrbGitHubVmOptions(
  options: OpenOrbGitHubMediationOptions,
): Result<OpenOrbGitHubVmOptions, GitHubMediationError> {
  const [repository, repositoryError] = parseCanonicalGitHubRepository(options.repositoryUrl);
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
        allowedHosts: [GITHUB_HOST, GITHUB_API_HOST],
        allowedInternalHosts: [],
        blockInternalRanges: true,
        replaceSecretsInQuery: false,
        secrets: token === undefined ? undefined : {
          GH_TOKEN: {
            hosts: [GITHUB_HOST, GITHUB_API_HOST],
            value: token,
          },
        },
        isRequestAllowed: (request) => isAllowedGitHubRequest(request, repository),
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
      GIT_CONFIG_KEY_2: `credential.https://${GITHUB_HOST}.helper`,
      GIT_CONFIG_VALUE_2: "!gh auth git-credential",
      GIT_CONFIG_KEY_3: `credential.https://${GITHUB_HOST}.useHttpPath`,
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

function parseCanonicalGitHubRepository(
  repositoryUrl: string,
): Result<GitHubRepository, GitHubMediationError> {
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

  return ok({
    owner,
    name,
    gitPath: `/${owner}/${name}.git`,
    apiPath: `/repos/${owner}/${name}`,
  });
}

export class GitHubMediationError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "GitHubMediationError";
  }
}

function isAllowedGitHubRequest(request: Request, repository: GitHubRepository): boolean {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    (url.hostname !== GITHUB_HOST && url.hostname !== GITHUB_API_HOST)
  ) {
    return false;
  }
  if (url.hostname === GITHUB_API_HOST) {
    return request.method === "GET" && url.pathname === repository.apiPath && !url.search;
  }
  if (url.pathname.startsWith(`${repository.gitPath}/`)) {
    const servicePath = url.pathname.slice(repository.gitPath.length + 1);
    if (servicePath === "info/refs") {
      const service = url.searchParams.get("service");
      return request.method === "GET" &&
        url.searchParams.size === 1 &&
        service !== null &&
        GIT_SERVICES.has(service);
    }
    return (servicePath === "git-upload-pack" || servicePath === "git-receive-pack") &&
      request.method === "POST" && !url.search;
  }
  return false;
}

function invalidRepositoryUrl(cause?: unknown): GitHubMediationError {
  return new GitHubMediationError(
    "The GitHub repository URL must use the canonical https://github.com/OWNER/REPOSITORY.git form.",
    cause,
  );
}
