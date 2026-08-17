import { createHttpHooks, type VMOptions } from "@earendil-works/gondolin";

const GITHUB_HOST = "github.com";
const GITHUB_API_HOST = "api.github.com";
const OPENORB_WORKSPACE_REPOSITORIES = "/workspace/*";
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
): OpenOrbGitHubVmOptions {
  const repository = parseCanonicalGitHubRepository(options.repositoryUrl);
  const token = options.token;
  if (
    token !== undefined && (token.length === 0 || token.length > 4096 || token.trim() !== token)
  ) {
    throw new Error(
      "The GitHub token must be a non-empty trimmed value of at most 4096 characters.",
    );
  }

  const { env: secretEnvironment, httpHooks } = createHttpHooks({
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
  });

  const env = {
    ...secretEnvironment,
    GH_HOST: GITHUB_HOST,
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_COUNT: token === undefined ? "1" : "3",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: OPENORB_WORKSPACE_REPOSITORIES,
    GIT_TERMINAL_PROMPT: "0",
    ...(token === undefined ? {} : {
      GIT_CONFIG_KEY_1: `credential.https://${GITHUB_HOST}.helper`,
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GIT_CONFIG_KEY_2: `credential.https://${GITHUB_HOST}.useHttpPath`,
      GIT_CONFIG_VALUE_2: "true",
    }),
  } satisfies Record<string, string>;

  return {
    allowWebSockets: false,
    dns: { mode: "synthetic" },
    env,
    httpHooks,
  };
}

function parseCanonicalGitHubRepository(repositoryUrl: string): GitHubRepository {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw invalidRepositoryUrl();
  }
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
    throw invalidRepositoryUrl();
  }

  const parts = url.pathname.slice(1, -4).split("/");
  if (parts.length !== 2) throw invalidRepositoryUrl();
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
    throw invalidRepositoryUrl();
  }

  return {
    owner,
    name,
    gitPath: `/${owner}/${name}.git`,
    apiPath: `/repos/${owner}/${name}`,
  };
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

function invalidRepositoryUrl(): Error {
  return new Error(
    "The GitHub repository URL must use the canonical https://github.com/OWNER/REPOSITORY.git form.",
  );
}
