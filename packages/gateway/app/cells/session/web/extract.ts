import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";
import { err, ok, type Result, tryAsync, trySync } from "@openorb/result";
import { BLOCKED_HINT, type FetchedDocument, WebFetchError } from "./egress.ts";

export interface ExtractedPage {
  readonly title: string | undefined;
  /** Markdown for HTML pages, plain text otherwise. */
  readonly text: string;
  /** A caveat about the text for the model, such as content the page loads with JavaScript. */
  readonly notice: string | undefined;
}

// Below this much text, a page with several scripts most likely renders its content in the browser.
const SCRIPTED_PAGE_TEXT = 500;
const SCRIPTED_PAGE_SCRIPTS = 3;

/**
 * Converts a fetched document to text for the model. Pages stay untrusted data throughout. Raw
 * extraction returns a text body exactly as decoded, even when empty; a PDF has no raw text form.
 */
export async function extractPage(
  document: FetchedDocument,
  { raw = false }: { readonly raw?: boolean } = {},
): Promise<Result<ExtractedPage, WebFetchError>> {
  if (raw && document.contentType !== "application/pdf") {
    return ok({
      title: undefined,
      text: decode(document.bytes, document.charset),
      notice: undefined,
    });
  }
  const [page, error] = await extractContent(document);
  if (error !== undefined) return err(error);
  if (page.text.trim() !== "") return ok(page);
  return err(
    new WebFetchError(
      page.notice === undefined
        ? `${new URL(document.url).host} returned no readable content.`
        : "The page loads its content with JavaScript, which web_fetch does not run. Try another source.",
    ),
  );
}

async function extractContent(
  document: FetchedDocument,
): Promise<Result<ExtractedPage, WebFetchError>> {
  if (document.contentType === "application/pdf") return await extractPdf(document.bytes);
  const text = decode(document.bytes, document.charset);
  if (document.contentType !== "text/html" && document.contentType !== "application/xhtml+xml") {
    return ok({ title: undefined, text, notice: undefined });
  }
  if (text.trim() === "") return ok({ title: undefined, text, notice: undefined });
  if (isCloudflareChallenge(text)) {
    const host = new URL(document.url).host;
    return err(
      new WebFetchError(
        `${host} answered with a Cloudflare bot check instead of the page. ${BLOCKED_HINT}`,
      ),
    );
  }
  // linkedom throws on some documents, such as an empty body; a page must never crash the tool.
  const [page, parseError] = trySync(
    () => htmlToMarkdown(text, document.url),
    (cause) => new WebFetchError("The page could not be read.", { cause }),
  );
  if (parseError !== undefined) return err(parseError);
  return ok(page);
}

/** Cloudflare's interstitial, which some sites serve with HTTP 200 and no cf-mitigated header. */
function isCloudflareChallenge(html: string): boolean {
  return (
    /<title>\s*Just a moment\.\.\.\s*<\/title>/iu.test(html) &&
    html.includes("window._cf_chl_opt") &&
    html.includes("/cdn-cgi/challenge-platform/")
  );
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  // An unknown or unsupported label falls back to the web's default encoding.
  const [text, error] = trySync(
    () => new TextDecoder(charset ?? "utf-8").decode(bytes),
    () => true,
  );
  if (error !== undefined) return new TextDecoder().decode(bytes);
  return text;
}

/** Readability's main content as Markdown, or the whole body when it finds no article. */
function htmlToMarkdown(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  const title = document.title.trim() || undefined;
  const scripts = document.querySelectorAll("script").length;
  // Readability mutates its input, so the fallback below reads the separate first parse.
  const article = new Readability(parseHTML(html).document, { charThreshold: 200 }).parse();
  const container = parseHTML("<!doctype html><html><body></body></html>").document;
  if (article?.content) {
    container.body.innerHTML = article.content;
  } else {
    for (const element of document.querySelectorAll("script, style, noscript, template, svg")) {
      element.remove();
    }
    container.body.innerHTML = document.body?.innerHTML ?? "";
  }
  // linkedom documents have no location, so links are resolved against the page here.
  for (const link of container.querySelectorAll("a[href]")) {
    const href = URL.parse(link.getAttribute("href") ?? "", url);
    if (href === null || (href.protocol !== "http:" && href.protocol !== "https:")) {
      link.removeAttribute("href");
    } else {
      link.setAttribute("href", href.href);
    }
  }
  const markdown = turndown.turndown(container.body).trim();
  const scripted = markdown.length < SCRIPTED_PAGE_TEXT && scripts > SCRIPTED_PAGE_SCRIPTS;
  return {
    title: article?.title?.trim() || title,
    text: markdown,
    notice: scripted
      ? "The page seems to load its content with JavaScript, which web_fetch does not run, so this text may be incomplete."
      : undefined,
  };
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// Images become their alt text: the transcript never embeds remote media.
turndown.addRule("images", {
  filter: "img",
  replacement: (_content, node) => {
    const alt = node.getAttribute("alt")?.trim();
    return alt ? `[image: ${alt}]` : "";
  },
});
turndown.remove(["script", "style", "noscript", "template", "iframe", "form", "button"]);

async function extractPdf(bytes: Uint8Array): Promise<Result<ExtractedPage, WebFetchError>> {
  const [pages, error] = await tryAsync(
    getDocumentProxy(bytes).then((pdf) => extractText(pdf, { mergePages: false })),
    (cause) => new WebFetchError("The PDF could not be read.", { cause }),
  );
  if (error !== undefined) return err(error);
  return ok({
    title: undefined,
    text: pages.text.map((page, index) => `## Page ${index + 1}\n\n${page.trim()}`).join("\n\n"),
    notice: undefined,
  });
}
