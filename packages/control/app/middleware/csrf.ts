import { csrf as csrfMiddleware } from "remix/middleware/csrf";

const publicUrl = Deno.env.get("PUBLIC_URL");
const portalOrigins = publicUrl ? getPortalOrigins(publicUrl) : undefined;

function getPortalOrigins(publicUrl: string) {
  const url = new URL(publicUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_URL must use http or https.");
  }

  // Amp's sandboxed Portal tab submits forms from an opaque origin.
  return [url.origin, "null"];
}

export function csrf() {
  return portalOrigins ? csrfMiddleware({ origin: portalOrigins }) : csrfMiddleware();
}
