import { routes } from "../../../routes.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Text that may be a URL; each candidate is parsed before its path is compared. */
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/gi;
/** Bounds the grants one prompt can make. */
const MAX_PASTED_SESSIONS = 20;

/** The Session IDs of Session page URLs, on any host, in a prompt the user submitted (ADR 0010). */
export function pastedSessionIds(prompt: string): string[] {
  const ids = new Set<string>();
  for (const [candidate] of prompt.matchAll(URL_CANDIDATE)) {
    const id = sessionIdOfUrl(candidate);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].slice(0, MAX_PASTED_SESSIONS);
}

/**
 * The Session a tool argument names: a bare Session ID or a Session URL. Naming a Session grants
 * nothing; access is checked separately.
 */
export function referencedSessionId(reference: string): string | undefined {
  const value = reference.trim();
  return SESSION_ID.test(value) ? value.toLowerCase() : sessionIdOfUrl(value);
}

/** The Session of a Session page URL, or of one of its subpages; undefined for any other URL. */
function sessionIdOfUrl(candidate: string): string | undefined {
  // Prose often ends a URL with punctuation that is not part of it.
  const trimmed = candidate.replace(/[.,;:!?)\]}]+$/, "");
  if (!URL.canParse(trimmed)) return undefined;
  const { pathname } = new URL(trimmed);
  const id = pathname.split("/").find((segment) => SESSION_ID.test(segment));
  if (id === undefined) return undefined;
  const page = routes.app.sessions.detail.href({ sessionId: id });
  return pathname === page || pathname.startsWith(`${page}/`) ? id.toLowerCase() : undefined;
}
