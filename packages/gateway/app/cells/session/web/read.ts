import { err, ok, type Result } from "@openorb/result";
import { fetchPublicDocument, IMAGE_EXTENSIONS, WebFetchError } from "./egress.ts";
import { type ExtractedPage, extractPage } from "./extract.ts";
import { githubTarget, readGitHubThread } from "./github.ts";

/** What web_fetch got for a URL: text for the model, or an image for the guest's read tool. */
export type FetchedContent =
  | {
      readonly kind: "page";
      readonly url: string;
      /** Not 2xx only for raw requests, which return error bodies too. */
      readonly status: number;
      readonly page: ExtractedPage;
    }
  | {
      readonly kind: "image";
      readonly url: string;
      readonly extension: string;
      readonly bytes: Uint8Array;
    };

/**
 * Fetches a URL as text or an image. GitHub files, pull requests, and issues are read from GitHub's
 * raw content and API instead of their script-rendered pages; a raw request still gets a pull
 * request's or issue's page as it is.
 */
export async function readUrl(
  input: string,
  options: {
    readonly signal: AbortSignal | undefined;
    readonly fetch: typeof fetch;
    readonly raw: boolean;
  },
): Promise<Result<FetchedContent, WebFetchError>> {
  const parsed = URL.parse(input);
  const github = parsed === null ? undefined : githubTarget(parsed);
  if (github !== undefined && github.kind !== "file" && !options.raw) {
    const [page, error] = await readGitHubThread(github, options);
    if (error !== undefined) return err(error);
    return ok({ kind: "page", url: github.url, status: 200, page });
  }
  const [document, fetchError] = await fetchPublicDocument(github?.url ?? input, options);
  if (fetchError !== undefined) return err(fetchError);
  const extension = IMAGE_EXTENSIONS.get(document.contentType);
  if (extension !== undefined) {
    return ok({ kind: "image", url: document.url, extension, bytes: document.bytes });
  }
  const [page, extractError] = await extractPage(document, { raw: options.raw });
  if (extractError !== undefined) return err(extractError);
  return ok({ kind: "page", url: document.url, status: document.status, page });
}
