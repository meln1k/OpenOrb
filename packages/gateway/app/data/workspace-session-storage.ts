import { createSession, type Session, type SessionStorage } from "remix/session";
import type { WorkspaceApi } from "@/app/cells/workspace/api.ts";

/** Updates and rotations never recreate a session removed by a concurrent logout. */
export class WorkspaceSessionStorage implements SessionStorage {
  readonly #origins = new WeakMap<Session, string>();

  constructor(private readonly workspace: WorkspaceApi) {}

  async read(cookie: string | null): Promise<Session> {
    const record = cookie ? await this.workspace.readBrowserSession(cookie) : null;
    if (!record || !cookie) return createSession();
    const session = createSession(cookie, record.data);
    this.#origins.set(session, cookie);
    return session;
  }

  async save(session: Session): Promise<string | null> {
    if (!session.destroyed && !session.dirty) return null;
    if (session.destroyed) {
      await this.workspace.deleteBrowserSessions(
        session.deleteId ? [session.id, session.deleteId] : [session.id],
      );
      return "";
    }
    const previousId = this.#origins.get(session);
    const mode = previousId === session.id
      ? "update"
      : previousId !== undefined && session.deleteId === previousId
      ? "rotate"
      : "insert";
    const saved = await this.workspace.saveBrowserSession({
      id: session.id,
      data: session.data,
      mode,
      ...(previousId === undefined ? {} : { previousId }),
    });
    if (saved) this.#origins.set(session, session.id);
    return saved ? session.id : "";
  }
}
