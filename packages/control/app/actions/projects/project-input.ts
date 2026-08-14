const GITHUB_OWNER_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function canonicalizeGitHubRepository(value: string): string | null {
  const input = value.trim();
  if (/[?@#]/.test(input)) return null;
  let owner: string;
  let repository: string;

  if (!input.includes("://")) {
    const parts = input.split("/");
    if (parts.length !== 2) return null;
    [owner, repository] = parts as [string, string];
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
    const parts = pathname.replace(/^\//, "").split("/");
    if (parts.length !== 2) return null;
    [owner, repository] = parts as [string, string];
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
