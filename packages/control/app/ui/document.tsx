import { css, type Handle, type RemixNode } from "remix/ui";

import { routes } from "@/app/routes.ts";

export interface DocumentProps {
  children?: RemixNode;
  title?: string;
}

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    const { children, title = "OpenOrb" } = handle.props;

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no"
          />
          <meta name="color-scheme" content="dark light" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <title>{title}</title>
        </head>
        <body mix={css({ margin: 0 })}>
          {children}
          <script
            type="module"
            src={routes.assets.href({ path: "app/assets/client.ts" })}
          />
        </body>
      </html>
    );
  };
}
