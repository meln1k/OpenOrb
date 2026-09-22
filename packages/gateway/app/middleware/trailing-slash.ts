import type { Middleware } from "remix/router";

export function rewriteTrailingSlash(): Middleware {
  return (context, next) => {
    if (context.url.pathname.length > 1) {
      context.url.pathname = context.url.pathname.replace(/\/$/, "");
    }
    return next();
  };
}
