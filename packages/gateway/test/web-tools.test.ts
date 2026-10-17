import { test } from "vite-plus/test";
import { assert, assertEquals, assertMatch, assertNotMatch } from "@jsr/std__assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ExecutionEnv, ok } from "@earendil-works/pi-durable/env";
import { blockedUrlReason, fetchPublicDocument } from "../app/cells/session/web/egress.ts";
import { extractPage } from "../app/cells/session/web/extract.ts";
import { searchWeb } from "../app/cells/session/web/search.ts";
import { MAX_SAVED_PAGES, WEB_PAGES_DIRECTORY } from "../app/cells/session/web/pages.ts";
import { fetchForModel } from "../app/cells/session/web/tools.ts";

test("web_fetch egress admits only public hosts on default ports", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://0x7f.1/", // WHATWG normalizes numeric spellings to 127.0.0.1
    "http://2130706433/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://100.64.0.0/",
    "http://172.16.0.0/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[2002:7f00:1::]/", // 6to4 embedding 127.0.0.1
    "http://[2001:0:4136:e378::1]/", // Teredo
    "http://localhost/",
    "http://api.localhost/",
    "http://metadata.google.internal/",
    "http://printer.local./",
    "http://intranet/",
    "ftp://example.com/",
    "http://user:secret@example.com/",
    "http://example.com:8080/",
  ];
  for (const url of blocked) assert(blockedUrlReason(new URL(url)), `${url} should be blocked`);
  const allowed = [
    "https://example.com/path?q=1",
    "http://93.184.216.34/",
    "http://100.63.255.255/",
    "http://172.15.255.255/",
    "http://172.32.0.0/",
    "https://[2606:4700:4700::1111]/",
    "https://example.com:443/",
  ];
  for (const url of allowed) assertEquals(blockedUrlReason(new URL(url)), undefined, url);
});

/** A scripted fetch that records every URL it is asked for and the headers it was sent. */
function scriptedFetch(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const headers: Headers[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    requested.push(url);
    headers.push(new Headers(init?.headers));
    const route = routes[url];
    return Promise.resolve(route ? route() : new Response("missing", { status: 404 }));
  };
  return { fetcher, requested, headers };
}

test("web_fetch re-checks every redirect hop before requesting it", async () => {
  const { fetcher, requested } = scriptedFetch({
    "https://example.com/start": () =>
      new Response(null, { status: 302, headers: { location: "/next" } }),
    "https://example.com/next": () =>
      new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } }),
  });
  const [, error] = await fetchPublicDocument("https://example.com/start", {
    signal: undefined,
    fetch: fetcher,
  });
  assertMatch(error?.message ?? "", /Private addresses cannot be fetched/);
  assertEquals(requested, ["https://example.com/start", "https://example.com/next"]);

  const loop = scriptedFetch(
    Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [
        `https://example.com/${index}`,
        () => new Response(null, { status: 307, headers: { location: `/${index + 1}` } }),
      ]),
    ),
  );
  const [, loopError] = await fetchPublicDocument("https://example.com/0", {
    signal: undefined,
    fetch: loop.fetcher,
  });
  assertEquals(loopError?.message, "Too many redirects.");
  assertEquals(loop.requested.length, 6);
});

test("web_fetch rejects oversized and unsupported responses", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const { fetcher } = scriptedFetch({
    // No Content-Length: the streaming limit must stop it.
    "https://example.com/stream": () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
    "https://example.com/declared": () =>
      new Response("small", {
        headers: { "content-type": "text/plain", "content-length": String(6 * 1024 * 1024) },
      }),
    "https://example.com/binary": () =>
      new Response("x", { headers: { "content-type": "application/octet-stream" } }),
    "https://example.com/latin1": () =>
      new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
        headers: { "content-type": "text/plain; charset=ISO-8859-1" },
      }),
  });
  const options = { signal: undefined, fetch: fetcher };
  for (const path of ["stream", "declared"]) {
    const [, error] = await fetchPublicDocument(`https://example.com/${path}`, options);
    assertEquals(error?.message, "The response is larger than 5 MiB.");
  }
  const [, binary] = await fetchPublicDocument("https://example.com/binary", options);
  assertMatch(binary?.message ?? "", /Unsupported content type/);
  const [latin1, latin1Error] = await fetchPublicDocument("https://example.com/latin1", options);
  assert(latin1Error === undefined);
  const [page] = await extractPage(latin1);
  assertEquals(page?.text, "café");
});

test("web_fetch tells the model when a site refuses automated requests", async () => {
  const html = { "content-type": "text/html" };
  const challenge =
    "<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script>" +
    '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>';
  const scripts = "<script>app()</script>".repeat(4);
  const { fetcher, headers } = scriptedFetch({
    "https://example.com/cf-header": () =>
      new Response("blocked", { status: 403, headers: { ...html, "cf-mitigated": "challenge" } }),
    // Some sites serve the interstitial with 200 and no cf-mitigated header.
    "https://example.com/cf-page": () => new Response(challenge, { headers: html }),
    "https://example.com/forbidden": () => new Response("no", { status: 403 }),
    "https://example.com/gone": () => new Response("no", { status: 404 }),
    "https://example.com/app": () =>
      new Response(`<html><body><div id="root"></div>${scripts}</body></html>`, { headers: html }),
    "https://example.com/short-app": () =>
      new Response(`<html><body><p>Loading the dashboard for you.</p>${scripts}</body></html>`, {
        headers: html,
      }),
    // IMDb answers bot checks with 202 and an empty HTML body, which linkedom cannot parse.
    "https://example.com/empty": () => new Response("", { status: 202, headers: html }),
    "https://example.com/short": () =>
      new Response("<html><body><p>A short page.</p><script>a()</script></body></html>", {
        headers: html,
      }),
  });
  const fetchText = async (path: string) => {
    const result = await fetchForModel(
      { url: `https://example.com/${path}` },
      { env: undefined, fetch: fetcher },
      BACKGROUND_CONTEXT,
    );
    const [item] = result.output;
    assert(item?.type === "text");
    return { text: item.text, isError: result.isError === true };
  };

  const blockedHint = /The site may block automated requests; try another source\.$/;
  for (const path of ["cf-header", "cf-page"]) {
    const { text, isError } = await fetchText(path);
    assert(isError);
    assertMatch(text, /^example\.com answered with a Cloudflare bot check instead of the page\./);
    assertMatch(text, blockedHint);
  }
  assertMatch((await fetchText("forbidden")).text, blockedHint);
  // A missing page is not a refusal, so it gets no blocking hint.
  assertEquals((await fetchText("gone")).text, "https://example.com/gone returned HTTP 404.");

  const app = await fetchText("app");
  assert(app.isError);
  assertMatch(app.text, /loads its content with JavaScript/);
  const shortApp = await fetchText("short-app");
  assert(!shortApp.isError);
  assertMatch(shortApp.text, /\nNote: The page seems to load its content with JavaScript/);
  assertMatch(shortApp.text, /Loading the dashboard for you\.$/);
  assertEquals((await fetchText("empty")).text, "example.com returned no readable content.");
  // A short page with few scripts is just short.
  assertNotMatch((await fetchText("short")).text, /Note:/);

  const sent = headers[0]!;
  assertMatch(sent.get("user-agent") ?? "", /Chrome\/\d+/);
  assertEquals(sent.get("accept-language"), "en-US,en;q=0.9");
  assertEquals(sent.get("sec-fetch-mode"), null);
});

test("HTML becomes Markdown of the main content with absolute links and no remote media", async () => {
  const paragraph = "OpenOrb hosts durable agent sessions on the gateway. ".repeat(12);
  const html = `<!doctype html><html><head><title>Site title</title>
    <script>alert("tracker")</script></head><body>
    <nav><a href="/home">Home</a> <a href="/about">About</a></nav>
    <article><h1>Durable sessions</h1><p>${paragraph}</p>
    <p>See <a href="../docs/adr">the ADRs</a> and <a href="javascript:alert(1)">this</a>.</p>
    <p><img src="https://tracker.example/pixel.gif" alt="Architecture diagram"> ${paragraph}</p>
    </article><footer>Copyright</footer></body></html>`;
  const [page, error] = await extractPage({
    url: "https://docs.example.com/guide/intro",
    status: 200,
    contentType: "text/html",
    charset: "utf-8",
    bytes: new TextEncoder().encode(html),
  });
  assert(error === undefined);
  // Readability demotes the article heading below the page title.
  assertMatch(page.text, /^## Durable sessions/m);
  assertMatch(page.text, /\[the ADRs\]\(https:\/\/docs\.example\.com\/docs\/adr\)/);
  assertMatch(page.text, /\[image: Architecture diagram\]/);
  assertNotMatch(page.text, /tracker|javascript:|alert/);
  assertNotMatch(page.text, /\[Home\]/);
});

test("PDF text is extracted page by page", async () => {
  const [page, error] = await extractPage({
    url: "https://example.com/report.pdf",
    status: 200,
    contentType: "application/pdf",
    charset: undefined,
    bytes: minimalPdf(["Quarterly report", "Second page findings"]),
  });
  assert(error === undefined, error?.message);
  assertMatch(page.text, /## Page 1\n\nQuarterly report/);
  assertMatch(page.text, /## Page 2\n\nSecond page findings/);
  const [, broken] = await extractPage({
    url: "https://example.com/broken.pdf",
    status: 200,
    contentType: "application/pdf",
    charset: undefined,
    bytes: new TextEncoder().encode("%PDF-1.4 truncated"),
  });
  assertEquals(broken?.message, "The PDF could not be read.");
});

/** A valid PDF with one line of Helvetica text per page; xref offsets are computed. */
function minimalPdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    objects[pageIds[index]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`;
    objects[pageIds[index]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const SEARCH = {
  query: "durable objects",
  numResults: 3,
  recency: "week",
  includeDomains: ["developers.cloudflare.com", "blog.cloudflare.com"],
  excludeDomains: ["spam.example"],
} as const;

test("web_search falls back past a failing provider without leaking its key", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://api.exa.ai/")) {
      return Promise.resolve(new Response("invalid key exa-key-123", { status: 401 }));
    }
    return Promise.resolve(
      Response.json({
        web: {
          results: [
            {
              title: "<strong>Durable</strong> Objects",
              url: "https://developers.cloudflare.com/durable-objects/",
              description: "Stateful &amp; <strong>serverless</strong>",
              page_age: "2026-10-01",
            },
          ],
        },
      }),
    );
  };
  const [response, error] = await searchWeb(
    // Listed out of order: the catalog order decides, so Exa is tried first.
    { brave: "brave-key-456", exa: "exa-key-123" },
    SEARCH,
    { signal: undefined, fetch: fetcher },
  );
  assert(error === undefined);
  assertEquals(response.provider, "brave");
  assertEquals(response.results, [
    {
      title: "Durable Objects",
      url: "https://developers.cloudflare.com/durable-objects/",
      snippet: "Stateful & serverless",
      published: "2026-10-01",
    },
  ]);
  const brave = new URL(calls[1]!.url);
  assertEquals(
    brave.searchParams.get("q"),
    "durable objects (site:developers.cloudflare.com OR site:blog.cloudflare.com) -site:spam.example",
  );
  assertEquals(brave.searchParams.get("freshness"), "pw");
  assertEquals(new Headers(calls[1]!.init?.headers).get("x-subscription-token"), "brave-key-456");

  const [, failed] = await searchWeb({ exa: "exa-key-123" }, SEARCH, {
    signal: undefined,
    fetch: fetcher,
  });
  assertEquals(failed?.message, "Web search failed. Exa: HTTP 401: invalid key [redacted]");

  const [, missing] = await searchWeb({}, SEARCH, { signal: undefined, fetch: fetcher });
  assertMatch(missing?.message ?? "", /Settings → Providers/);
});

test("web_search redacts a key that straddles the error truncation point", async () => {
  const apiKey = "exa-straddling-key-0123456789";
  const fetcher: typeof fetch = () =>
    Promise.resolve(new Response(`${"x".repeat(190)} ${apiKey} trailing`, { status: 403 }));
  const [, error] = await searchWeb({ exa: apiKey }, SEARCH, { signal: undefined, fetch: fetcher });
  // The cut may shorten the marker, but no prefix of the key survives it.
  assertMatch(error?.message ?? "", /\[redacted/);
  assertNotMatch(error?.message ?? "", /exa-/);
});

test("web_search maps Exa and Tavily requests and answers", async () => {
  const bodies = new Map<string, string>();
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    bodies.set(url, String(init?.body));
    if (url === "https://api.exa.ai/search") {
      return Promise.resolve(
        Response.json({
          results: [{ title: null, url: "https://a.example/", highlights: ["one", "two"] }],
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        answer: "  Durable Objects are stateful.  ",
        results: [{ title: "B", url: "https://b.example/", content: "line\n  two" }],
      }),
    );
  };
  const [exa] = await searchWeb({ exa: "k" }, SEARCH, {
    signal: undefined,
    fetch: fetcher,
  });
  assertEquals(exa?.results, [
    {
      title: "https://a.example/",
      url: "https://a.example/",
      snippet: "one … two",
      published: undefined,
    },
  ]);
  const { startPublishedDate, ...exaBody } = JSON.parse(bodies.get("https://api.exa.ai/search")!);
  assertEquals(exaBody, {
    query: "durable objects",
    type: "auto",
    numResults: 3,
    contents: { highlights: true },
    includeDomains: ["developers.cloudflare.com", "blog.cloudflare.com"],
    excludeDomains: ["spam.example"],
  });
  const weekAgo = Date.now() - 7 * 86_400_000;
  assert(Math.abs(Date.parse(String(startPublishedDate)) - weekAgo) < 60_000);

  const [tavily] = await searchWeb({ tavily: "k" }, SEARCH, {
    signal: undefined,
    fetch: fetcher,
  });
  assertEquals(tavily?.answer, "Durable Objects are stateful.");
  assertEquals(tavily?.results[0]?.snippet, "line two");
  assertEquals(JSON.parse(bodies.get("https://api.tavily.com/search")!), {
    query: "durable objects",
    max_results: 3,
    search_depth: "basic",
    include_answer: true,
    time_range: "week",
    include_domains: ["developers.cloudflare.com", "blog.cloudflare.com"],
    exclude_domains: ["spam.example"],
  });
});

test("web_fetch saves the full page in the guest and continues long pages by offset", async () => {
  const lines = Array.from({ length: 3_000 }, (_, index) => `line ${index}`);
  const { fetcher } = scriptedFetch({
    "https://example.com/long.txt": () =>
      new Response(lines.join("\n"), { headers: { "content-type": "text/plain" } }),
  });
  const { env, written } = guestFiles();
  const execute = (args: { url: string; offset?: number }) =>
    fetchForModel(args, { env, fetch: fetcher }, BACKGROUND_CONTEXT).then((result) => {
      const [item] = result.output;
      assert(item?.type === "text");
      return item.text;
    });

  const first = await execute({ url: "https://example.com/long.txt" });
  assertEquals(written.get(`${WEB_PAGES_DIRECTORY}/.gitignore`), "*\n");
  const [path, content] = [...written].find(([name]) => name.endsWith(".md"))!;
  assert(path.startsWith(`${WEB_PAGES_DIRECTORY}/example.com-`));
  assertEquals(content, lines.join("\n"));
  assertMatch(first, new RegExp(`Saved: ${path}`));
  const end = Number(first.match(/Continue with web_fetch offset (\d+)/)?.[1]);
  // The first part ends on a line boundary within the 1,500-line limit.
  assertEquals(lines.join("\n").slice(0, end), `${lines.slice(0, 1_500).join("\n")}\n`);
  assertMatch(first, /\nline 1499\n$/);

  const second = await execute({ url: "https://example.com/long.txt", offset: end });
  assertMatch(second, /\n\nline 1500\n/);
  assertMatch(second, /line 2999$/);
  assertNotMatch(second, /Continue with web_fetch/);
  // Continuing the same page overwrites its saved copy instead of adding another.
  assertMatch(second, new RegExp(`Saved: ${path}`));

  const blocked = await fetchForModel(
    { url: "http://localhost:3000/" },
    { env, fetch: fetcher },
    BACKGROUND_CONTEXT,
  );
  assertEquals(blocked.isError, true);
  assertEquals([...written.keys()].toSorted(), [`${WEB_PAGES_DIRECTORY}/.gitignore`, path]);
});

test("web_fetch keeps only the newest saved pages", async () => {
  const fetcher: typeof fetch = () =>
    Promise.resolve(new Response("page", { headers: { "content-type": "text/plain" } }));
  const { env, written } = guestFiles();
  const save = async (url: string) => {
    const result = await fetchForModel({ url }, { env, fetch: fetcher }, BACKGROUND_CONTEXT);
    const [item] = result.output;
    assert(item?.type === "text");
    return item.text.match(/Saved: (\S+)/)![1]!;
  };
  const pages = () => [...written.keys()].filter((path) => path.endsWith(".md")).toSorted();
  const saved: string[] = [];
  for (let index = 0; index < MAX_SAVED_PAGES + 2; index++) {
    saved.push(await save(`https://example.com/${index}`));
  }
  assertEquals(pages(), saved.slice(2).toSorted());
  // Fetching a page again makes it the newest, so the next new page removes the one after it.
  await save("https://example.com/2");
  saved.push(await save("https://example.com/new"));
  assertEquals(pages(), [saved[2]!, ...saved.slice(4)].toSorted());
});

test("web_fetch reads GitHub through raw content and the API, and saves images for read", async () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const user = (login: string) => ({ login });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const { fetcher, requested } = scriptedFetch({
    "https://raw.githubusercontent.com/acme/app/feature/x/src/main.ts": () =>
      new Response("export const answer = 42;\n", { headers: { "content-type": "text/plain" } }),
    "https://api.github.com/repos/acme/app/pulls/7": () =>
      json({
        title: "Add retries",
        state: "open",
        draft: false,
        merged: false,
        user: user("alice"),
        body: "Retries flaky requests.",
        labels: [{ name: "bug" }],
        created_at: "2026-10-01T00:00:00Z",
        head: { label: "alice:retries" },
        base: { ref: "main" },
        additions: 3,
        deletions: 1,
        changed_files: 1,
      }),
    "https://api.github.com/repos/acme/app/issues/7/comments?per_page=100": () =>
      json([{ user: null, created_at: "2026-10-02T00:00:00Z", body: "Looks good." }]),
    "https://api.github.com/repos/acme/app/pulls/7/comments?per_page=100": () =>
      json([
        {
          user: user("bob"),
          created_at: "2026-10-03T00:00:00Z",
          body: "Cap the delay.",
          path: "src/retry.ts",
          line: 12,
        },
      ]),
    // The diff itself contains a code fence, so the block around it needs a longer one.
    "https://github.com/acme/app/pull/7.diff": () =>
      new Response("+const doc = `\n+```ts\n+```\n+`;\n", {
        headers: { "content-type": "text/plain" },
      }),
    "https://api.github.com/repos/acme/app/issues/8": () =>
      new Response('{"message":"API rate limit exceeded for 203.0.113.9."}', {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    "https://api.github.com/repos/acme/app/issues/8/comments?per_page=100": () => json([]),
    "https://example.com/diagram.png": () =>
      new Response(png, { headers: { "content-type": "image/png" } }),
  });
  const { env, written } = guestFiles();
  const fetchText = async (url: string) => {
    const result = await fetchForModel({ url }, { env, fetch: fetcher }, BACKGROUND_CONTEXT);
    const [item] = result.output;
    assert(item?.type === "text");
    return { text: item.text, isError: result.isError === true };
  };

  // A branch with a slash stays part of the raw path.
  const file = await fetchText("https://github.com/acme/app/blob/feature/x/src/main.ts");
  assertMatch(file.text, /\n\nexport const answer = 42;\n$/);

  const pull = await fetchText("https://github.com/acme/app/pull/7/files#discussion_r1");
  assert(!pull.isError);
  assertMatch(pull.text, /^URL: https:\/\/github\.com\/acme\/app\/pull\/7\n/);
  assertMatch(pull.text, /Title: Add retries · Pull Request #7 · acme\/app/);
  assertMatch(
    pull.text,
    /Pull request · open · @alice wants to merge alice:retries into main · \+3 −1 in 1 files · labels: bug/,
  );
  assertMatch(
    pull.text,
    /## Comments \(1\)\n\n### a deleted user · 2026-10-02T00:00:00Z\n\nLooks good\./,
  );
  assertMatch(pull.text, /### @bob on `src\/retry\.ts` line 12 · /);
  assertMatch(pull.text, /\n````diff\n\+const doc = `\n\+```ts\n\+```\n\+`;\n````$/);

  const limited = await fetchText("https://github.com/acme/app/issues/8");
  assert(limited.isError);
  assertMatch(limited.text, /^GitHub's rate limit for unauthenticated requests/);

  const image = await fetchText("https://example.com/diagram.png");
  const path = image.text.match(/saved to (\S+\.png)\n/)?.[1];
  assert(path !== undefined && path.startsWith(`${WEB_PAGES_DIRECTORY}/example.com-`), image.text);
  assertEquals(written.get(path), png);
  assertMatch(image.text, new RegExp(`Use read on ${path} to view it\\.$`));

  // Neither GitHub page itself was requested.
  assert(!requested.some((url) => url.startsWith("https://github.com/acme/app/blob")));
  assert(!requested.includes("https://github.com/acme/app/pull/7/files"));
});

test("raw web_fetch returns bodies as they are, error statuses included", async () => {
  const html = "<html><body><h1>Hi</h1><p>Some <b>bold</b> text.</p></body></html>";
  const { fetcher } = scriptedFetch({
    "https://example.com/page": () =>
      new Response(html, { headers: { "content-type": "text/html" } }),
    "https://api.example.com/v1/items": () =>
      new Response('{"error":"bad token"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  });
  const { env, written } = guestFiles();
  const run = async (url: string, raw: boolean) => {
    const result = await fetchForModel({ url, raw }, { env, fetch: fetcher }, BACKGROUND_CONTEXT);
    const [item] = result.output;
    assert(item?.type === "text");
    return { text: item.text, isError: result.isError === true };
  };

  const source = await run("https://example.com/page", true);
  assertMatch(source.text, new RegExp(`\\n\\n${html.replaceAll("/", "\\/")}$`));
  assertNotMatch(source.text, /Status:/);
  const readable = await run("https://example.com/page", false);
  assertMatch(readable.text, /Some \*\*bold\*\* text\./);
  // Raw and readable copies of one page are separate files.
  const saved = [...written.keys()].filter((path) => path !== `${WEB_PAGES_DIRECTORY}/.gitignore`);
  assertEquals(saved.map((path) => path.split(".").pop()).toSorted(), ["md", "txt"]);

  const apiError = await run("https://api.example.com/v1/items", true);
  assert(!apiError.isError);
  assertMatch(apiError.text, /\nStatus: 401\n/);
  assertMatch(apiError.text, /\n\n\{"error":"bad token"\}$/);
  assert((await run("https://api.example.com/v1/items", false)).isError);
});

/** An in-memory guest directory whose modification times follow write order. */
function guestFiles() {
  const written = new Map<string, string | Uint8Array>();
  const modified = new Map<string, number>();
  let clock = 0;
  const env: Pick<ExecutionEnv, "createDir" | "writeFile" | "listDir" | "remove"> = {
    createDir: () => Promise.resolve(ok(undefined)),
    writeFile: (path, content) => {
      written.set(path, content);
      modified.set(path, ++clock);
      return Promise.resolve(ok(undefined));
    },
    listDir: (directory) =>
      Promise.resolve(
        ok(
          [...written].map(([path, content]) => ({
            name: path.slice(directory.length + 1),
            path,
            kind: "file" as const,
            size: content.length,
            mtimeMs: modified.get(path)!,
          })),
        ),
      ),
    remove: (path) => {
      written.delete(path);
      return Promise.resolve(ok(undefined));
    },
  };
  return { env, written };
}
