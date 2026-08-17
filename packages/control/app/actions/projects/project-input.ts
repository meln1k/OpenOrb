const GITHUB_OWNER_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function canonicalizeGitHubRepository(value: string): string | null {
  const input = value.trim();
  if (/[?@#]/.test(input)) return null;
  let owner: string;
  let repository: string;

  if (!input.includes("://")) {
    const parts = splitRepositoryPath(input);
    if (!parts) return null;
    [owner, repository] = parts;
  } else {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const parts = splitRepositoryPath(pathname.replace(/^\//, ""));
    if (!parts) return null;
    [owner, repository] = parts;
  }

  if (repository.endsWith(".git")) repository = repository.slice(0, -4);
  if (
    !GITHUB_OWNER_PATTERN.test(owner) ||
    !GITHUB_REPOSITORY_PATTERN.test(repository) ||
    repository === "." ||
    repository === ".."
  ) {
    return null;
  }

  return `https://github.com/${owner}/${repository}.git`;
}

function splitRepositoryPath(path: string): [string, string] | null {
  const parts = path.split("/");
  const owner = parts[0];
  const repository = parts[1];
  return parts.length === 2 && owner !== undefined && repository !== undefined
    ? [owner, repository]
    : null;
}
