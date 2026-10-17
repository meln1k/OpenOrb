import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { encodeHex } from "@jsr/std__encoding/hex";
import { err, ok, type Result } from "@openorb/result";

/**
 * Guest directory for full fetched pages. It persists with the Project Checkout on every provider,
 * and a self-ignoring .gitignore keeps the pages out of Git status and commits.
 */
export const WEB_PAGES_DIRECTORY = "/workspace/.openorb/web";
/** Saved pages and images kept per Session; older ones are removed as new ones arrive. */
export const MAX_SAVED_PAGES = 20;

/** The guest operations web_fetch uses to save a page and remove old ones. */
export type PageStore = Pick<ExecutionEnv, "createDir" | "writeFile" | "listDir" | "remove">;

/**
 * Writes a fetched page or image into the guest under a name derived from `key`, so continuing a
 * page or a replayed call overwrites the same file. The .gitignore is written first, so Git never
 * sees a page. Returns the path, or why nothing was saved; a stopped guest only loses the copy.
 */
export async function saveFetched(
  env: PageStore | undefined,
  file: {
    /** Identifies the content: the URL, plus anything that changes what is saved for it. */
    readonly key: string;
    readonly url: string;
    readonly extension: string;
    readonly content: string | Uint8Array;
  },
  context: Context,
): Promise<Result<string, string>> {
  if (env === undefined) return err("no guest environment");
  const host = new URL(file.url).hostname.replace(/[^a-z0-9.-]/gu, "_").slice(0, 64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.key));
  const name = `${host}-${encodeHex(digest).slice(0, 12)}.${file.extension}`;
  const created = await env.createDir(WEB_PAGES_DIRECTORY, { recursive: true }, context);
  const ignored = created.ok
    ? await env.writeFile(`${WEB_PAGES_DIRECTORY}/.gitignore`, "*\n", context)
    : created;
  const written = ignored.ok
    ? await env.writeFile(`${WEB_PAGES_DIRECTORY}/${name}`, file.content, context)
    : ignored;
  if (!written.ok) return err(written.error.message);
  await removeOldPages(env, name, context);
  return ok(`${WEB_PAGES_DIRECTORY}/${name}`);
}

/** Keeps the newest saved pages, always including the one just written. Failures only keep more. */
async function removeOldPages(env: PageStore, current: string, context: Context) {
  const listed = await env.listDir(WEB_PAGES_DIRECTORY, context);
  if (!listed.ok) return;
  const older = listed.value
    .filter(
      (entry) => entry.kind === "file" && entry.name !== ".gitignore" && entry.name !== current,
    )
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(MAX_SAVED_PAGES - 1);
  await Promise.all(
    older.map((entry) =>
      env.remove(`${WEB_PAGES_DIRECTORY}/${entry.name}`, { force: true }, context),
    ),
  );
}
