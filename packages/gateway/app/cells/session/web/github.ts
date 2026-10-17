import { err, ok, type Result, trySync } from "@openorb/result";
import { Schema } from "effect";
import { fetchPublicDocument, WebFetchError } from "./egress.ts";
import type { ExtractedPage } from "./extract.ts";

/**
 * GitHub renders files, pull requests, and issues with JavaScript, so their pages hold almost no
 * text. A file is fetched from raw.githubusercontent.com instead, and a pull request or issue is
 * rendered from GitHub's public REST API. Requests carry no credentials and pass the same egress
 * policy as any other fetch; unauthenticated API calls share GitHub's per-address rate limit.
 */
export type GitHubTarget =
  | { readonly kind: "file"; readonly url: string }
  | {
      readonly kind: "pull" | "issue";
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
      /** The canonical page, without sub-pages such as /files or comment anchors. */
      readonly url: string;
    };

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
// GitHub pages comments 100 at a time; a longer thread says where the rest is.
const MAX_COMMENTS = 100;

/** What a github.com URL needs instead of its page, or undefined for any other URL. */
export function githubTarget(url: URL): GitHubTarget | undefined {
  if (!GITHUB_HOSTS.has(url.hostname)) return undefined;
  const [, owner = "", repo = "", section, ...rest] = url.pathname.split("/");
  if (owner === "" || repo === "") return undefined;
  if (section === "blob" && rest.length >= 2 && rest.every((part) => part !== "")) {
    return {
      kind: "file",
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`,
    };
  }
  const number = rest[0] ?? "";
  if ((section === "pull" || section === "issues") && /^[1-9]\d{0,9}$/u.test(number)) {
    return {
      kind: section === "pull" ? "pull" : "issue",
      owner,
      repo,
      number: Number(number),
      url: `https://github.com/${owner}/${repo}/${section}/${number}`,
    };
  }
  return undefined;
}

const Text = Schema.NullOr(Schema.String);
const User = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const Labels = Schema.Array(Schema.Struct({ name: Schema.String }));

const Issue = Schema.Struct({
  title: Schema.String,
  state: Schema.String,
  user: User,
  body: Text,
  labels: Labels,
  created_at: Schema.String,
});

const PullRequest = Schema.Struct({
  ...Issue.fields,
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.Boolean,
  head: Schema.Struct({ label: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  additions: Schema.Number,
  deletions: Schema.Number,
  changed_files: Schema.Number,
});

const Comments = Schema.Array(
  Schema.Struct({
    user: User,
    created_at: Schema.String,
    body: Text,
    path: Schema.optional(Schema.String),
    line: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);
type Comment = (typeof Comments.Type)[number];

interface GitHubOptions {
  readonly signal: AbortSignal | undefined;
  readonly fetch: typeof fetch;
}

/** A pull request or issue as one Markdown document: description, comments, and a PR's diff. */
export async function readGitHubThread(
  target: Extract<GitHubTarget, { kind: "pull" | "issue" }>,
  options: GitHubOptions,
): Promise<Result<ExtractedPage, WebFetchError>> {
  const api = `https://api.github.com/repos/${target.owner}/${target.repo}`;
  const what = `${target.kind === "pull" ? "pull request" : "issue"} #${target.number} in ${target.owner}/${target.repo}`;
  const comments = `${api}/issues/${target.number}/comments?per_page=${MAX_COMMENTS}`;
  // Every request starts at once; each Result is checked as it is awaited.
  const discussionRequest = requestJson(comments, Comments, what, options);
  if (target.kind === "issue") {
    const issueRequest = requestJson(`${api}/issues/${target.number}`, Issue, what, options);
    const [issue, issueError] = await issueRequest;
    if (issueError !== undefined) return err(issueError);
    const [discussion, discussionError] = await discussionRequest;
    if (discussionError !== undefined) return err(discussionError);
    const lines = [
      `# ${issue.title} (#${target.number})`,
      "",
      `Issue · ${issue.state} · opened by ${author(issue.user)} on ${issue.created_at}${labelText(issue.labels)}`,
      "",
      issue.body?.trim() || "_No description._",
      ...commentSection("Comments", discussion, target.url),
    ];
    return ok(threadPage(`${issue.title} · Issue #${target.number}`, target, lines));
  }
  const pullRequest = requestJson(`${api}/pulls/${target.number}`, PullRequest, what, options);
  const reviewsRequest = requestJson(
    `${api}/pulls/${target.number}/comments?per_page=${MAX_COMMENTS}`,
    Comments,
    what,
    options,
  );
  const diffSection = readDiff(`${target.url}.diff`, what, options);
  const [pull, pullError] = await pullRequest;
  if (pullError !== undefined) return err(pullError);
  const [discussion, discussionError] = await discussionRequest;
  if (discussionError !== undefined) return err(discussionError);
  const [reviews, reviewsError] = await reviewsRequest;
  if (reviewsError !== undefined) return err(reviewsError);
  const state = pull.merged ? "merged" : pull.draft === true ? `${pull.state}, draft` : pull.state;
  const lines = [
    `# ${pull.title} (#${target.number})`,
    "",
    `Pull request · ${state} · ${author(pull.user)} wants to merge ${pull.head.label} into ${pull.base.ref} · +${pull.additions} −${pull.deletions} in ${pull.changed_files} files${labelText(pull.labels)}`,
    `Opened on ${pull.created_at}`,
    "",
    pull.body?.trim() || "_No description._",
    ...commentSection("Comments", discussion, target.url),
    ...commentSection("Review comments", reviews, `${target.url}/files`),
    "",
    "## Diff",
    "",
    ...(await diffSection),
  ];
  return ok(threadPage(`${pull.title} · Pull Request #${target.number}`, target, lines));
}

/** The diff as a fenced block; one that cannot be read leaves the rest of the pull request useful. */
async function readDiff(url: string, what: string, options: GitHubOptions): Promise<string[]> {
  const [diff, error] = await requestText(url, what, options);
  if (error !== undefined) return [`_The diff could not be fetched: ${error.message}_`];
  return fenced("diff", diff);
}

function threadPage(title: string, target: GitHubTarget, lines: readonly string[]): ExtractedPage {
  return {
    title: `${title} · ${target.url.split("/").slice(3, 5).join("/")}`,
    text: lines.join("\n"),
    notice: undefined,
  };
}

function commentSection(heading: string, comments: readonly Comment[], moreAt: string): string[] {
  if (comments.length === 0) return [];
  const lines = [
    "",
    `## ${heading} (${comments.length === MAX_COMMENTS ? `first ${MAX_COMMENTS}; the rest are on ${moreAt}` : comments.length})`,
  ];
  for (const comment of comments) {
    const place =
      comment.path === undefined
        ? ""
        : ` on \`${comment.path}\`${comment.line == null ? "" : ` line ${comment.line}`}`;
    lines.push(
      "",
      `### ${author(comment.user)}${place} · ${comment.created_at}`,
      "",
      comment.body?.trim() ?? "",
    );
  }
  return lines;
}

function author(user: typeof User.Type): string {
  return user === null ? "a deleted user" : `@${user.login}`;
}

function labelText(labels: typeof Labels.Type): string {
  return labels.length === 0 ? "" : ` · labels: ${labels.map((label) => label.name).join(", ")}`;
}

/** A fenced block whose fence is longer than any backtick run inside it. */
function fenced(language: string, body: string): string[] {
  const longest = Math.max(2, ...[...body.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}${language}`, body.trimEnd(), fence];
}

async function requestJson<T>(
  url: string,
  schema: Schema.Decoder<T>,
  what: string,
  options: GitHubOptions,
): Promise<Result<T, WebFetchError>> {
  const [body, error] = await requestText(url, what, options);
  if (error !== undefined) return err(error);
  const [json, parseError] = trySync(
    () => JSON.parse(body),
    () => new WebFetchError(`GitHub sent an unexpected response for ${what}.`),
  );
  if (parseError !== undefined) return err(parseError);
  const decoded = Schema.decodeUnknownOption(schema)(json);
  return decoded._tag === "Some"
    ? ok(decoded.value)
    : err(new WebFetchError(`GitHub sent an unexpected response for ${what}.`));
}

/** A successful response's text; a failure names what GitHub refused, including its rate limit. */
async function requestText(
  url: string,
  what: string,
  options: GitHubOptions,
): Promise<Result<string, WebFetchError>> {
  const [document, error] = await fetchPublicDocument(url, { ...options, raw: true });
  if (error !== undefined) return err(error);
  const body = new TextDecoder().decode(document.bytes);
  if (document.status >= 200 && document.status < 300) return ok(body);
  if ((document.status === 403 || document.status === 429) && /rate limit/iu.test(body)) {
    return err(
      new WebFetchError(
        "GitHub's rate limit for unauthenticated requests from this gateway is used up. Try again later, or use git or gh in the guest.",
      ),
    );
  }
  if (document.status === 404) {
    return err(new WebFetchError(`GitHub has no public ${what}.`));
  }
  return err(new WebFetchError(`GitHub returned HTTP ${document.status} for ${what}.`));
}
