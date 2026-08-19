import { encodeBase64Url } from "@std/encoding/base64url";

export function generateRunnerSecret(prefix: string): string {
  return `${prefix}${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function hashRunnerSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest).toHex();
}
