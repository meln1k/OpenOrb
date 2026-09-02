import type {
  SessionEvent,
  SessionIssue,
  SessionProvisioningStage,
} from "@openorb/protocol/browser-session-events";
import { trySync } from "../../../../result/src/index.ts";
import { parseSafe, string } from "remix/data-schema";
import { type Handle, type RemixNode, TypedEventTarget } from "remix/ui";

import { routes } from "@/app/routes.ts";
import {
  runnerSessionStateForProvisioningStage,
  type SessionState,
} from "@/app/ui/session/session-transcript-state.ts";

interface SessionPageEventMap {
  readonly connection: Event;
  readonly session: CustomEvent<SessionEvent>;
}

export interface SessionPageProjection {
  readonly connectionInterrupted: boolean;
  readonly sessionState: SessionState;
  readonly stage: SessionProvisioningStage | null;
  readonly issues: readonly SessionIssue[];
}

export class SessionPageController extends TypedEventTarget<SessionPageEventMap> {
  #projection: SessionPageProjection;

  constructor(initialState: SessionState, initialIssues: readonly SessionIssue[]) {
    super();
    this.#projection = {
      connectionInterrupted: initialState === "offline",
      sessionState: initialState,
      stage: null,
      issues: initialIssues,
    };
  }

  get projection(): SessionPageProjection {
    return this.#projection;
  }

  apply(event: SessionEvent): void {
    if (event.type === "session.state") {
      this.#projection = {
        ...this.#projection,
        sessionState: runnerSessionStateForProvisioningStage(event.stage),
        stage: event.stage,
        issues: event.issues,
      };
    }
    this.dispatchEvent(new CustomEvent("session", { detail: event }));
  }

  setConnectionInterrupted(interrupted: boolean): void {
    if (this.#projection.connectionInterrupted === interrupted) return;
    this.#projection = { ...this.#projection, connectionInterrupted: interrupted };
    this.dispatchEvent(new Event("connection"));
  }
}

interface SessionPageScopeProps {
  readonly children?: RemixNode;
  readonly csrfToken: string;
  readonly initialState: SessionState;
  readonly initialIssues: readonly SessionIssue[];
  readonly sessionId: string;
}

export function SessionPageScope(
  handle: Handle<SessionPageScopeProps, SessionPageController>,
) {
  const controller = new SessionPageController(
    handle.props.initialState,
    handle.props.initialIssues,
  );
  handle.context.set(controller);

  handle.queueTask(() => {
    if (handle.props.initialState === "ready" || handle.props.initialState === "running") {
      const body = new FormData();
      body.set("_csrf", handle.props.csrfToken);
      void fetch(routes.api.sessions.wake.href({ sessionId: handle.props.sessionId }), {
        method: "POST",
        body,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: handle.signal,
      }).catch(() => undefined);
    }

    const stream = new EventSource(
      routes.api.sessions.events.href({ sessionId: handle.props.sessionId }),
    );
    stream.addEventListener("open", () => controller.setConnectionInterrupted(false));
    stream.addEventListener("session", (message) => {
      if (!(message instanceof MessageEvent)) return;
      const encoded = parseSafe(string(), message.data);
      if (!encoded.success) return;
      const event = parseSessionEvent(encoded.value);
      if (event) controller.apply(event);
    });
    stream.addEventListener("error", () => controller.setConnectionInterrupted(true));
    handle.signal.addEventListener("abort", () => stream.close(), { once: true });
  });

  return () => <>{handle.props.children}</>;
}

function parseSessionEvent(source: string): SessionEvent | null {
  const [value, parseError] = trySync(
    () => {
      // SAFETY: The gateway emits only runner events decoded by the canonical WatchSessionEvent
      // schema, and serves the matching browser assets in the same deployment.
      return JSON.parse(source) as SessionEvent;
    },
    () => true,
  );
  if (parseError !== undefined) return null;
  return value;
}
