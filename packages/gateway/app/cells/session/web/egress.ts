import { LimitedBytesTransformStream } from "@jsr/std__streams/limited-bytes-transform-stream";
import { err, ok, type Result, tryAsync } from "@openorb/result";
import { ContentType } from "remix/headers/content-type";

/**
 * Gateway egress for web_fetch. The model chooses these URLs, so every hop must name a public
 * HTTP(S) host on a default port. The Worker runtime resolves DNS itself and cannot pin an
 * address: names are rejected by suffix and IP literals by range, but a public name that resolves
 * to a private address is stopped only by the deployment's network policy (ADR 0009).
 */

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const TOO_LARGE = "The response is larger than 5 MiB.";
// A desktop Chrome identity, since some sites refuse clients that do not look like a browser. The
// AI-fetcher identities other tools borrow were refused outright by some sites, and browser
// Sec-Fetch-* headers made some bot checks refuse requests they otherwise allowed.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";
export const BLOCKED_HINT = "The site may block automated requests; try another source.";
const ACCEPT =
  "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, application/pdf;q=0.7, */*;q=0.1";

/** A failure the model can act on; its message is safe to show. */
export class WebFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebFetchError";
  }
}

export interface FetchedDocument {
  /** The final URL after redirects. */
  readonly url: string;
  /** Only raw requests return a document whose status is not 2xx. */
  readonly status: number;
  /** The lowercase media type without parameters. */
  readonly contentType: string;
  readonly charset: string | undefined;
  readonly bytes: Uint8Array;
}

/** Names that resolve inside private networks or to this host. */
const BLOCKED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "arpa",
];

// [network, prefix length]: unspecified, private, shared, loopback, link-local and metadata,
// IETF and documentation, benchmarking, multicast, reserved, and broadcast ranges.
const BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Why the gateway must not request `url`, or undefined when it may. */
export function blockedUrlReason(url: URL): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http and https URLs can be fetched.";
  }
  if (url.username !== "" || url.password !== "") return "URLs with credentials cannot be fetched.";
  if (url.port !== "") return "Only the default http and https ports can be fetched.";
  // WHATWG parsing already normalized numeric IPv4 spellings such as 0x7f.1 to dotted quads.
  const host = url.hostname.replace(/\.$/u, "");
  if (host.startsWith("[")) {
    return isPublicIpv6(host.slice(1, -1)) ? undefined : "Private addresses cannot be fetched.";
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) {
    return BLOCKED_IPV4.some(([network, bits]) => inRange(ipv4, parseIpv4(network)!, bits))
      ? "Private addresses cannot be fetched."
      : undefined;
  }
  if (!host.includes(".")) return "Single-label host names cannot be fetched.";
  if (BLOCKED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return "Local and internal host names cannot be fetched.";
  }
  return undefined;
}

/**
 * GETs a public URL without credentials, following at most five redirects that each pass the same
 * policy, and reads at most {@link MAX_RESPONSE_BYTES} of the body.
 */
export async function fetchPublicDocument(
  input: string,
  options: {
    readonly signal: AbortSignal | undefined;
    readonly fetch: typeof fetch;
    /** Return the body of an error or bot-check response too, instead of rejecting it. */
    readonly raw?: boolean;
  },
): Promise<Result<FetchedDocument, WebFetchError>> {
  const { timeout, signal } = withTimeout(options.signal, FETCH_TIMEOUT_MS);
  const failure = (message: string) => (cause: unknown) =>
    new WebFetchError(
      timeout.aborted
        ? "The request timed out."
        : signal.aborted
          ? "The request was aborted."
          : cause instanceof RangeError
            ? TOO_LARGE
            : message,
      { cause },
    );
  let url = URL.parse(input);
  for (let redirects = 0; ; redirects++) {
    if (url === null) return err(new WebFetchError("Invalid URL."));
    url.hash = "";
    const reason = blockedUrlReason(url);
    if (reason !== undefined) return err(new WebFetchError(`${reason} (${url.href})`));
    const [response, requestError] = await tryAsync(
      options.fetch(url.href, {
        redirect: "manual",
        headers: { accept: ACCEPT, "accept-language": ACCEPT_LANGUAGE, "user-agent": USER_AGENT },
        signal,
      }),
      failure(`The request to ${url.host} failed.`),
    );
    if (requestError !== undefined) return err(requestError);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      if (redirects === MAX_REDIRECTS) return err(new WebFetchError("Too many redirects."));
      url = URL.parse(location, url);
      continue;
    }
    const { mediaType = "", charset } = ContentType.from(response.headers.get("content-type"));
    const contentType = mediaType.toLowerCase();
    const rejection = rejectionReason(response, url, contentType, options.raw === true);
    if (rejection !== undefined) {
      await response.body?.cancel();
      return err(new WebFetchError(rejection));
    }
    const limited = response.body?.pipeThrough(
      new LimitedBytesTransformStream(MAX_RESPONSE_BYTES, { error: true }),
    );
    // celld's Response has no bytes(); then() also turns a synchronous throw into a rejection.
    const [body, bodyError] = await tryAsync(
      Promise.resolve().then(() => new Response(limited).arrayBuffer()),
      failure(`Reading the response from ${url.host} failed.`),
    );
    if (bodyError !== undefined) return err(bodyError);
    return ok({
      url: url.href,
      status: response.status,
      contentType,
      charset,
      bytes: new Uint8Array(body),
    });
  }
}

/** A deadline for one outbound request that the caller's cancellation also ends. */
export function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  return { timeout, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) };
}

/** Statuses bot checks answer with, so the model knows a retry will not help. */
const REFUSED_STATUSES = new Set([401, 403, 429]);

/**
 * Why a final response cannot be used, or undefined when its body should be read. A raw request
 * wants error and bot-check bodies as they are, so only their type and size are checked.
 */
function rejectionReason(
  response: Response,
  url: URL,
  contentType: string,
  raw: boolean,
): string | undefined {
  if (!raw && response.headers.get("cf-mitigated") === "challenge") {
    return `${url.host} answered with a Cloudflare bot check instead of the page. ${BLOCKED_HINT}`;
  }
  if (!raw && !response.ok) {
    const hint = REFUSED_STATUSES.has(response.status) ? ` ${BLOCKED_HINT}` : "";
    return `${url.href} returned HTTP ${response.status}.${hint}`;
  }
  if (!isSupportedContentType(contentType)) {
    return `Unsupported content type ${JSON.stringify(contentType)}.`;
  }
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) return TOO_LARGE;
  return undefined;
}

/** Image types the guest's read tool shows the model, by the extension a saved copy gets. */
export const IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

function isSupportedContentType(type: string): boolean {
  return (
    type === "" ||
    IMAGE_EXTENSIONS.has(type) ||
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function parseIpv4(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function inRange(address: number, network: number, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(network / size);
}

/**
 * Only global unicast 2000::/3 is public, excluding 2001::/23 (Teredo and other IETF
 * assignments), 2001:db8::/32 (documentation), and 2002::/16 (6to4, which embeds IPv4).
 * Mapped, translated, unique-local, link-local, and multicast addresses all fall outside it.
 */
function isPublicIpv6(host: string): boolean {
  const [first, second] = expandIpv6(host);
  if (first === undefined || second === undefined) return false;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  return first !== 0x2002;
}

/** The leading two 16-bit groups of a URL-canonical IPv6 address. */
function expandIpv6(host: string): number[] {
  const [head = "", tail] = host.split("::");
  const leading = head === "" ? [] : head.split(":");
  const trailing = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups =
    tail === undefined
      ? leading
      : [...leading, ...Array<string>(8 - leading.length - trailing.length).fill("0"), ...trailing];
  return groups.slice(0, 2).map((group) => Number.parseInt(group, 16));
}
