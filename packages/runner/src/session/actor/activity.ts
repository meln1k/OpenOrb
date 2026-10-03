import type { ConversationView } from "../../harness/agent-harness.ts";

/** Read-only projection; no second task state machine or task journal. */
export function conversationActivity(view: ConversationView) {
  const live = view.docs["pi.live"];
  const run = live?.run;
  const inbox = view.docs["pi.inbox"]?.items;
  return {
    busy: run !== undefined ||
      (Array.isArray(live?.compactions) && live.compactions.length > 0) ||
      (Array.isArray(inbox) && inbox.length > 0),
  };
}
