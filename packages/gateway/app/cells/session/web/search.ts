import { err, ok, type Result, tryAsync } from "@openorb/result";
import { Schema } from "effect";
import {
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDER_NAMES,
  type SearchProviderId,
} from "../../../search-provider-catalog.ts";
import type { SearchProviderKeys } from "../../workspace/api.ts";
import { withTimeout } from "./egress.ts";

const SEARCH_TIMEOUT_MS = 20_000;

export type SearchRecency = "day" | "week" | "month" | "year";

export interface SearchRequest {
  readonly query: string;
  readonly numResults: number;
  readonly recency: SearchRecency | undefined;
  readonly includeDomains: readonly string[];
  readonly excludeDomains: readonly string[];
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published: string | undefined;
}

export interface SearchResponse {
  readonly provider: SearchProviderId;
  readonly answer: string | undefined;
  readonly results: readonly SearchResult[];
}

/** No configured provider answered; the message names each failure and never contains a key. */
export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}

/**
 * Searches with the first configured provider that answers, in catalog order. A failed provider
 * falls through to the next one; an empty answer is a valid result and does not.
 */
export async function searchWeb(
  keys: SearchProviderKeys,
  request: SearchRequest,
  options: { readonly signal: AbortSignal | undefined; readonly fetch: typeof fetch },
): Promise<Result<SearchResponse, WebSearchError>> {
  const failures: string[] = [];
  for (const providerId of SEARCH_PROVIDER_IDS) {
    const apiKey = keys[providerId];
    if (apiKey === undefined) continue;
    const { timeout, signal } = withTimeout(options.signal, SEARCH_TIMEOUT_MS);
    const [response, failure] = await PROVIDERS[providerId]({
      request,
      apiKey,
      signal,
      fetch: options.fetch,
    });
    if (failure === undefined) return ok({ provider: providerId, ...response });
    if (options.signal?.aborted) return err(new WebSearchError("Web search was aborted."));
    failures.push(
      `${SEARCH_PROVIDER_NAMES[providerId]}: ${timeout.aborted ? "timed out" : failure}`,
    );
  }
  return err(
    new WebSearchError(
      failures.length === 0
        ? "No web search provider is configured. Ask the user to add an Exa, Brave Search, or Tavily API key in Settings → Providers."
        : `Web search failed. ${failures.join("; ")}`,
    ),
  );
}

/** Markdown for the model: the provider, its answer when it gives one, and numbered results. */
export function formatSearchResponse(query: string, response: SearchResponse): string {
  const lines = [
    `Search results for ${JSON.stringify(query)} from ${SEARCH_PROVIDER_NAMES[response.provider]}:`,
  ];
  if (response.answer !== undefined) lines.push("", `Answer: ${response.answer}`);
  if (response.results.length === 0) lines.push("", "No results.");
  response.results.forEach((result, index) => {
    lines.push("", `${index + 1}. ${result.title}`, `   ${result.url}`);
    if (result.published !== undefined) lines.push(`   Published: ${result.published}`);
    if (result.snippet !== "") lines.push(`   ${result.snippet}`);
  });
  return lines.join("\n");
}

interface ProviderCall {
  readonly request: SearchRequest;
  readonly apiKey: string;
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
}

type ProviderAnswer = Omit<SearchResponse, "provider">;

/** A provider's answer, or why it failed in words that never include its key. */
type ProviderSearch = (call: ProviderCall) => Promise<Result<ProviderAnswer, string>>;

const PROVIDERS = {
  exa: searchExa,
  brave: searchBrave,
  tavily: searchTavily,
} satisfies Record<SearchProviderId, ProviderSearch>;

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

const ExaResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      title: OptionalText,
      url: Schema.String,
      publishedDate: OptionalText,
      highlights: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      text: OptionalText,
    }),
  ),
});

async function searchExa({ request, apiKey, signal, fetch }: ProviderCall) {
  const startPublishedDate = recencyStart(request.recency);
  const response = fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query: request.query,
      type: "auto",
      numResults: request.numResults,
      contents: { highlights: true },
      ...(request.includeDomains.length > 0 ? { includeDomains: request.includeDomains } : {}),
      ...(request.excludeDomains.length > 0 ? { excludeDomains: request.excludeDomains } : {}),
      ...(startPublishedDate === undefined ? {} : { startPublishedDate }),
    }),
    signal,
  });
  const [data, error] = await decodeResponse(response, ExaResponse, apiKey);
  if (error !== undefined) return err(error);
  return ok({
    answer: undefined,
    results: data.results.map((result) => ({
      title: result.title?.trim() || result.url,
      url: result.url,
      snippet: oneLine(result.highlights?.join(" … ") || result.text?.slice(0, 500) || ""),
      published: result.publishedDate ?? undefined,
    })),
  });
}

const BraveResponse = Schema.Struct({
  web: Schema.optional(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          title: OptionalText,
          url: Schema.String,
          description: OptionalText,
          page_age: OptionalText,
        }),
      ),
    }),
  ),
});

const BRAVE_FRESHNESS = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
} satisfies Record<SearchRecency, string>;

async function searchBrave({ request, apiKey, signal, fetch }: ProviderCall) {
  // Brave has no domain parameters; its query operators do the same.
  const include = request.includeDomains.map((domain) => `site:${domain}`).join(" OR ");
  const exclude = request.excludeDomains.map((domain) => `-site:${domain}`).join(" ");
  const query = [
    request.query,
    request.includeDomains.length > 1 ? `(${include})` : include,
    exclude,
  ]
    .filter((part) => part !== "")
    .join(" ");
  const parameters = new URLSearchParams({ q: query, count: String(request.numResults) });
  if (request.recency !== undefined) {
    parameters.set("freshness", BRAVE_FRESHNESS[request.recency]);
  }
  const response = fetch(`https://api.search.brave.com/res/v1/web/search?${parameters}`, {
    headers: { accept: "application/json", "x-subscription-token": apiKey },
    signal,
  });
  const [data, error] = await decodeResponse(response, BraveResponse, apiKey);
  if (error !== undefined) return err(error);
  return ok({
    answer: undefined,
    results: (data.web?.results ?? []).map((result) => ({
      title: stripTags(result.title ?? "") || result.url,
      url: result.url,
      snippet: oneLine(stripTags(result.description ?? "")),
      published: result.page_age ?? undefined,
    })),
  });
}

const TavilyResponse = Schema.Struct({
  answer: OptionalText,
  results: Schema.Array(
    Schema.Struct({
      title: OptionalText,
      url: Schema.String,
      content: OptionalText,
      published_date: OptionalText,
    }),
  ),
});

async function searchTavily({ request, apiKey, signal, fetch }: ProviderCall) {
  const response = fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: request.query,
      max_results: request.numResults,
      search_depth: "basic",
      include_answer: true,
      ...(request.recency === undefined ? {} : { time_range: request.recency }),
      ...(request.includeDomains.length > 0 ? { include_domains: request.includeDomains } : {}),
      ...(request.excludeDomains.length > 0 ? { exclude_domains: request.excludeDomains } : {}),
    }),
    signal,
  });
  const [data, error] = await decodeResponse(response, TavilyResponse, apiKey);
  if (error !== undefined) return err(error);
  return ok({
    answer: data.answer?.trim() || undefined,
    results: data.results.map((result) => ({
      title: result.title?.trim() || result.url,
      url: result.url,
      snippet: oneLine(result.content ?? ""),
      published: result.published_date ?? undefined,
    })),
  });
}

/** The decoded body of a successful response, or a short reason with the key removed. */
async function decodeResponse<T>(
  request: Promise<Response>,
  schema: Schema.Decoder<T>,
  apiKey: string,
): Promise<Result<T, string>> {
  const [response, requestError] = await tryAsync(request, () => "request failed");
  if (requestError !== undefined) return err(requestError);
  if (!response.ok) {
    const [body, bodyError] = await tryAsync(response.text(), () => true);
    if (bodyError !== undefined) return err(`HTTP ${response.status}`);
    // Redact before truncating, so a key cut in half cannot slip through.
    const detail = oneLine(body.replaceAll(apiKey, "[redacted]")).slice(0, 200);
    return err(`HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
  }
  const [body, bodyError] = await tryAsync(response.json(), () => "unexpected response");
  if (bodyError !== undefined) return err(bodyError);
  const decoded = Schema.decodeUnknownOption(schema)(body);
  return decoded._tag === "Some" ? ok(decoded.value) : err("unexpected response");
}

const RECENCY_DAYS = { day: 1, week: 7, month: 31, year: 365 } satisfies Record<
  SearchRecency,
  number
>;

function recencyStart(recency: SearchRecency | undefined): string | undefined {
  if (recency === undefined) return undefined;
  return new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString();
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/gu, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
