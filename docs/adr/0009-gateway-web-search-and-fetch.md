# Web search and fetch run on the gateway

**Status:** Accepted; implements the web fetch tool anticipated by ADR 0007

The agent gets two OpenOrb-owned tools, `web_search` and `web_fetch`, registered beside
`environment` and `publish_media`. Both run in the Session Durable Object, so they work the same on
every Agent Environment Provider. That includes the Sandbox, whose guest stays without network.
pi-web-access, an upstream Pi extension, was the reference, but it is not installed: Pi Durable runs
only OpenOrb-owned tools, and most of its code is provider breadth, browser-cookie scraping, LLM
summarisation, and a curator UI that OpenOrb does not need.

## Search

`web_search` takes a query, a result count up to 10, an optional recency (day, week, month, or
year), and optional domain filters, where a `-` prefix excludes a domain. It returns a Markdown list
of titles, URLs, and snippets, plus the provider's answer when it gives one. Three providers are
supported, each with a Workspace API key:

- Exa
- Brave Search, which has no domain parameters, so the filters become `site:` operators
- Tavily

The tool tries the configured providers in that fixed order and moves to the next one only when a
call fails. An empty result list is a valid answer and does not fall through. Keys live in
`search_provider_credentials`, which references `encrypted_secrets` rows with the existing
`provider-api-key` purpose, exactly like `model_provider_credentials`. The provider ID comes from
that table, which admits only the three IDs, never from a secret name. Settings → Providers shows one
row per provider. The Session reads keys from the Workspace at each search, decrypted only in its
memory; they never reach a runner. Error messages from providers are bounded and have the key
replaced before the model sees them. With no key configured, the tool returns an error that tells
the agent to ask the user to add one.

## Fetch

`web_fetch` GETs a URL without cookies or credentials and converts the response:

- HTML: linkedom, Readability, and Turndown produce Markdown of the main content, or of the whole
  body when Readability finds no article. Links become absolute, non-HTTP links are dropped, and
  images become their alt text, so nothing remote is embedded.
- PDF: unpdf extracts text page by page.
- Text, JSON, and XML are returned as decoded text.
- Images (PNG, JPEG, GIF, and WebP) are saved in the guest, and the result tells the agent to open
  them with `read`, which already checks an image's format and size and attaches it for the model.
  The gateway does not decode images itself.

With `raw`, the body is returned as decoded text instead, such as HTML source or an API's JSON, and
error and bot-check responses are returned with their status rather than refused. A PDF is still
extracted, because its bytes are no use as text.

GitHub renders files, pull requests, and issues with JavaScript, so their pages hold a few hundred
characters of navigation. The tool reads them another way. A `github.com/…/blob/…` URL is fetched
from `raw.githubusercontent.com`. A pull request or issue becomes one Markdown document built from
GitHub's public REST API: the description, up to 100 comments, up to 100 review comments, and a pull
request's `.diff`. These requests go through the same egress policy as any other fetch and carry no
credentials. Unauthenticated API calls share GitHub's limit of 60 an hour per address, and running
out is reported as such so the agent can use `git` or `gh` in the guest instead. A raw fetch of a
pull request or issue returns its page as it is.

Requests send a desktop Chrome `User-Agent` and `Accept-Language: en-US`, because some sites refuse
clients that do not look like a browser. Nothing else imitates a browser: the identities other
tools borrow from AI companies' fetchers were refused outright by some sites, and browser
`Sec-Fetch-*` headers made some bot checks refuse requests they otherwise allowed. Many sites block
gateway requests whatever they send, by network address or TLS fingerprint. The tool reports those
plainly so the agent tries another source: a Cloudflare challenge, whether marked by
`cf-mitigated` or served as a page with HTTP 200, and a 401, 403, or 429 are named as a refusal of
automated requests. A page with little text and several scripts carries a note that it renders
with JavaScript, which the tool does not run, and an empty page is an error.

The model sees at most 40,000 bytes or 1,500 lines inline, cut on a line boundary, below Pi
Durable's default tool output limits so nothing is truncated silently. The tool also writes the full
text to `/workspace/.openorb/web/` in the guest through the provider's `ExecutionEnv`, where `read`
and `grep` can page and search it. The file is named after the host and a hash of the final URL
(raw text gets a file of its own), so continuing a page or replaying the call overwrites the same
file. Only the 20 newest pages and images are kept.

The directory lives in the Project Checkout because that is the one path every provider both lets
the agent write and keeps across turns and Stop: the Sandbox drops `/tmp` whenever it is released
after a run, and runners keep `/tmp` in tmpfs. Before the first page, the tool writes a `.gitignore`
containing `*` into the directory, so pages never appear in Git status, Git Snapshots, or a commit,
without touching `.git` or the project's own ignore files.

When the guest is unavailable, the save
is skipped and the tool still answers; `offset` continues a long page from the gateway either way.
Both tools declare `replay: "safe"`: rerunning a search or GET after a crash has no effect beyond
its cost.

## Security

This is the first gateway egress whose destination the model chooses. Every hop must pass the same
policy before it is requested:

- only `http` and `https`, on the default port, with no user information in the URL
- no single-label names, and no `localhost`, `local`, `internal`, `intranet`, `lan`, `home`, `corp`,
  `private`, or `arpa` names or subdomains
- no IPv4 literal in an unspecified, private, shared, loopback, link-local or metadata,
  documentation, benchmarking, multicast, reserved, or broadcast range. URL parsing normalises
  numeric spellings such as `0x7f.1` first.
- IPv6 literals only in global unicast `2000::/3`, excluding Teredo and other `2001::/23`
  assignments, documentation, and 6to4. Mapped, translated, unique-local, and link-local addresses
  are rejected.

Redirects are followed manually, at most five, each re-checked. Bodies over 5 MiB are rejected,
whether declared or streamed, and requests time out after 30 seconds. Content types outside text,
JSON, XML, and PDF are rejected.

The Worker runtime resolves DNS itself and gives no way to pin the address it connects to. A public
name that resolves to a private address, including through DNS rebinding, therefore passes these
checks. Operators must deny the gateway process egress to private, loopback, link-local, and
metadata networks at the host or network layer; the gateway needs none of them, because runners dial
in. The [gateway operations guide](../operations.md) records this requirement.

Fetched pages and search results are untrusted data. The tool descriptions and the system prompt say
so, and the transcript renders tool results as plain text. A page can still try to steer the agent
by prompt injection; the boundary is that the tools carry no credentials and cannot reach private
networks, not that the content is filtered.

## Rejected alternatives

- **Fetching in the guest.** Gondolin already blocks internal targets and DNS rebinding for runner
  guests, but the Sandbox has no network, so behaviour would split by provider. Search keys would
  also have to enter the guest or be mediated per provider.
- **A DNS-over-HTTPS preflight.** It would catch names that resolve privately in public DNS, but it
  sends every fetched host name to a third-party resolver, still cannot pin the address, and misses
  split-horizon names. Network policy closes the gap completely.
- **A separate tool for stored content.** pi-web-access keeps fetched pages in its own store behind
  `get_search_content`. The guest file reuses `read` and `grep` instead.
- **Saving pages in `/tmp` or `/var/lib`.** `/tmp` is gone after every Sandbox run, so a later turn
  would find only a dangling path, and a runner guest may not be allowed to write under `/var/lib`.
- **An entry in `.git/info/exclude`.** It needs a Git directory at a known path, which worktrees and
  checkouts without Git lack; the self-ignoring `.gitignore` works everywhere.
- **A hosted reader as a fallback for blocked pages.** Services such as Jina Reader fetch from their
  own networks and get past many bot checks, but every URL the agent fetches would go to a third
  party, which also sees a redirect chain the gateway never checked.
- **The Workspace's GitHub credential for API calls.** It would lift the rate limit and reach
  private repositories, but it would put a credential on requests the model triggers. Agents with
  repository access already have `git` and `gh` in the guest.
- **Browser impersonation.** Matching a browser's TLS fingerprint or rendering pages in a headless
  browser would get past more bot checks, but the Worker runtime offers neither, and a browser
  would be a far larger attack surface than an HTTP client.
- **Keyless scraping and more providers.** DuckDuckGo HTML scraping breaks on bot checks, and each
  additional provider is more code to keep correct. More can be added behind the same interface.
