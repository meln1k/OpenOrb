import { csrf as csrfMiddleware } from "remix/middleware/csrf";
import { AppServicesKey } from "./services.ts";
import type { Middleware } from "remix/router";

function getPublicOrigin(publicUrl: string) {
  const url = new URL(publicUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublicUrlConfigurationError("PUBLIC_URL must use http or https.");
  }

  return url.origin;
}

class PublicUrlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUrlConfigurationError";
  }
}

export function csrf() {
  const middleware: Middleware = (context, next) => {
    const publicUrl = context.get(AppServicesKey)?.publicUrl;
    return csrfMiddleware(publicUrl ? { origin: getPublicOrigin(publicUrl) } : {})(context, next);
  };
  return middleware;
}
