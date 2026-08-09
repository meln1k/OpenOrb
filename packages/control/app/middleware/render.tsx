import { basename, extname } from "@std/path";

import type { Router } from "remix/router";
import { renderWith } from "remix/middleware/render";
import { createHtmlResponse } from "remix/response/html";
import type { RemixNode } from "remix/ui";
import { renderToStream } from "remix/ui/server";

import { assetServer } from "../assets.ts";

export function render() {
  return renderWith(
    ({ request, router }) =>
      function render(node: RemixNode, init?: ResponseInit) {
        const stream = renderToStream(node, {
          frameSrc: request.url,
          signal: request.signal,
          resolveFrame: (src) => resolveFrame(router, request, src),
          // Server rendering turns client entries into browser module URLs.
          async resolveClientEntry(entryId, component) {
            if (!entryId.startsWith("file://")) {
              throw new Error(
                `Expected \`import.meta.url\` for clientEntry ID, received '${entryId}'`,
              );
            }

            return {
              href: await assetServer.getHref(entryId),
              exportName: entryId.split("#")[1] || component.name || titleCaseFileName(entryId),
            };
          },
        });

        return createHtmlResponse(stream, init);
      },
  );
}

async function resolveFrame(router: Router, request: Request, src: string) {
  const url = new URL(src, request.url);

  const headers = new Headers();
  headers.set("Accept", "text/html");

  const cookie = request.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);

  const response = await router.fetch(
    new Request(url, {
      method: "GET",
      headers,
      signal: request.signal,
    }),
  );

  if (!response.ok) {
    return `<pre>Frame error: ${response.status} ${response.statusText}</pre>`;
  }

  if (response.body) return response.body;
  return await response.text();
}

function titleCaseFileName(fileUrl: string): string {
  const url = new URL(fileUrl);
  const fileName = basename(url.pathname, extname(url.pathname));
  return fileName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}
