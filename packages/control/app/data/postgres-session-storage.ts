import type { Pool } from "pg";
import { any, array, parseSafe, record, string } from "remix/data-schema";
import { createSession, type Session, type SessionStorage } from "remix/session";

import { parseBrowserSessionAuth } from "@/app/utils/session-policy.ts";

type BrowserSessionData = Session["data"];
type SessionOrigin = { readonly kind: "new" } | { readonly kind: "persisted"; readonly id: string };
type SessionIdentity =
  | { readonly kind: "anonymous" }
  | { readonly kind: "authenticated"; readonly userId: string }
  | { readonly kind: "invalid" };
const sessionDataMapSchema = record(string(), any());
const browserSessionDataSchema = array(sessionDataMapSchema);

/**
 * Owns the PostgreSQL lifecycle of browser sessions.
 *
 * Persisted sessions are updated rather than upserted so a stale concurrent
 * request cannot recreate a session that was logged out or rotated away.
 */
export class PostgresSessionStorage implements SessionStorage {
  private readonly origins = new WeakMap<Session, SessionOrigin>();

  constructor(
    private readonly pool: Pool,
    private readonly maxAgeSeconds: number,
  ) {}

  async read(cookie: string | null): Promise<Session> {
    if (!cookie) {
      return this.createNewSession();
    }

    const result = await this.pool.query<{
      user_id: string | null;
      data: unknown;
      expires_at: Date | string;
    }>(
      `select user_id, data, expires_at
         from browser_sessions
        where id = $1`,
      [cookie],
    );
    const row = result.rows[0];
    if (!row) {
      return this.createNewSession();
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.deleteSessions([cookie]);
      return this.createNewSession();
    }

    const data = parseSessionData(row.data);
    if (!data) {
      await this.deleteSessions([cookie]);
      return this.createNewSession();
    }

    const identity = parseSessionIdentity(data);
    const userId = identity.kind === "authenticated" ? identity.userId : null;
    if (identity.kind === "invalid" || userId !== row.user_id) {
      await this.deleteSessions([cookie]);
      return this.createNewSession();
    }

    const currentSession = createSession(cookie, data);
    this.origins.set(currentSession, { kind: "persisted", id: cookie });
    return currentSession;
  }

  async save(currentSession: Session): Promise<string | null> {
    if (!currentSession.destroyed && !currentSession.dirty) {
      return null;
    }

    await this.deleteExpiredSessions();

    if (currentSession.destroyed) {
      await this.deleteSessions(
        currentSession.deleteId
          ? [currentSession.id, currentSession.deleteId]
          : [currentSession.id],
      );
      return "";
    }

    const origin = this.origins.get(currentSession) ?? { kind: "new" };
    if (origin.kind === "new") {
      await this.insert(currentSession);
      this.origins.set(currentSession, { kind: "persisted", id: currentSession.id });
      return currentSession.id;
    }

    if (currentSession.id === origin.id) {
      const updated = await this.update(currentSession);
      return updated ? currentSession.id : "";
    }

    if (currentSession.deleteId === origin.id) {
      const rotated = await this.rotate(origin.id, currentSession);
      if (rotated) {
        this.origins.set(currentSession, { kind: "persisted", id: currentSession.id });
      }
      return rotated ? currentSession.id : "";
    }

    // regenerateId(false) deliberately preserves the old session.
    await this.insert(currentSession);
    this.origins.set(currentSession, { kind: "persisted", id: currentSession.id });
    return currentSession.id;
  }

  private createNewSession(): Session {
    const currentSession = createSession();
    this.origins.set(currentSession, { kind: "new" });
    return currentSession;
  }

  private async insert(currentSession: Session): Promise<void> {
    const userId = sessionUserId(currentSession.data);
    await this.pool.query(
      `insert into browser_sessions (id, user_id, data, expires_at, created_at, updated_at)
       values ($1, $2, $3::jsonb, now() + ($4 * interval '1 second'), now(), now())`,
      [currentSession.id, userId, JSON.stringify(currentSession.data), this.maxAgeSeconds],
    );
  }

  private async update(currentSession: Session): Promise<boolean> {
    const userId = sessionUserId(currentSession.data);
    const result = await this.pool.query(
      `update browser_sessions
          set data = $2::jsonb,
              expires_at = now() + ($3 * interval '1 second'),
              updated_at = now()
        where id = $1
          and user_id is not distinct from $4
          and expires_at > now()`,
      [currentSession.id, JSON.stringify(currentSession.data), this.maxAgeSeconds, userId],
    );
    return result.rowCount === 1;
  }

  private async rotate(previousId: string, currentSession: Session): Promise<boolean> {
    const userId = sessionUserId(currentSession.data);
    const result = await this.pool.query<{ id: string }>(
      `with deleted_session as (
         delete from browser_sessions
          where id = $5
            and expires_at > now()
         returning id
       ), inserted_session as (
         insert into browser_sessions (id, user_id, data, expires_at, created_at, updated_at)
         select $1, $2, $3::jsonb, now() + ($4 * interval '1 second'), now(), now()
           from deleted_session
         returning id
       )
       select id from inserted_session`,
      [
        currentSession.id,
        userId,
        JSON.stringify(currentSession.data),
        this.maxAgeSeconds,
        previousId,
      ],
    );
    return result.rowCount === 1;
  }

  private async deleteExpiredSessions(): Promise<void> {
    await this.pool.query("delete from browser_sessions where expires_at <= now()");
  }

  private async deleteSessions(ids: string[]): Promise<void> {
    await this.pool.query("delete from browser_sessions where id = any($1::text[])", [ids]);
  }
}

function parseSessionData(value: unknown): BrowserSessionData | null {
  const parsed = parseSafe(browserSessionDataSchema, value);
  if (!parsed.success || parsed.value.length !== 2) return null;
  const values = parsed.value[0];
  const flashes = parsed.value[1];
  return values === undefined || flashes === undefined ? null : [values, flashes];
}

function sessionUserId(data: unknown): string | null {
  const parsed = parseSessionData(data);
  if (!parsed) {
    throw new Error("Cannot persist malformed browser session data.");
  }

  const identity = parseSessionIdentity(parsed);
  if (identity.kind === "invalid") {
    throw new Error("Cannot persist malformed browser session authentication.");
  }
  return identity.kind === "authenticated" ? identity.userId : null;
}

function parseSessionIdentity(data: BrowserSessionData): SessionIdentity {
  const values = data[0];
  if (!("auth" in values)) {
    return { kind: "anonymous" };
  }

  const auth = parseBrowserSessionAuth(values.auth);
  return auth ? { kind: "authenticated", userId: auth.userId } : { kind: "invalid" };
}
