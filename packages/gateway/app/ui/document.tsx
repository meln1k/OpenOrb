import { css, type Handle, type RemixNode } from "remix/ui";
import { ImportMap } from "remix/ui/server";

import { clientScriptEntry } from "@/app/assets.ts";

export interface DocumentProps {
  children?: RemixNode;
  title?: string;
}

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { children, title = "OpenOrb" } = handle.props;

    return (
      <html lang="en" mix={css({ overscrollBehavior: "none" })}>
        <head>
          <meta charSet="utf-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, interactive-widget=resizes-content"
          />
          <meta name="color-scheme" content="dark light" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <title>{title}</title>
          <ImportMap value={clientScriptEntry.importMap} />
          {clientScriptEntry.preloads.map((href) => (
            <link key={href} rel="modulepreload" href={href} />
          ))}
        </head>
        <body mix={css({ margin: 0 })}>
          {children}
          <script type="module" src={clientScriptEntry.href} />
        </body>
      </html>
    );
  };
}
