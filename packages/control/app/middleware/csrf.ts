import { csrf as csrfMiddleware } from "remix/middleware/csrf";

const publicUrl = Deno.env.get("PUBLIC_URL");
const publicOrigin = publicUrl ? getPublicOrigin(publicUrl) : undefined;

function getPublicOrigin(publicUrl: string) {
  const url = new URL(publicUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_URL must use http or https.");
  }

  return url.origin;
}

export function csrf() {
  return csrfMiddleware({ origin: publicOrigin });
}
