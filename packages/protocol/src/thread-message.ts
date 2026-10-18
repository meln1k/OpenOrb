/**
 * Prompts from other threads (ADR 0010): the label a Session's model reads, and the transcript
 * entry its browser page shows instead.
 */

/** The entry kind a prompt from another thread is placed as, instead of `pi.user`. */
export const THREAD_MESSAGE_KIND = "openorb.thread-message";

/** Who sent a prompt from another thread, as its transcript entry records it. */
export interface ThreadMessageData {
  /** The sender's relation to the receiving Session. */
  readonly relation: "parent" | "child";
  readonly sessionId: string;
  /** The sender's Initial Prompt Preview, which names it in the sidebar. */
  readonly title: string;
}

/** A prompt from another Session, labelled for the model with who sent it. */
export function threadMessage(
  relation: "parent" | "child",
  fromSessionId: string,
  message: string,
): string {
  return `${threadMessageLabel(relation, fromSessionId)}${message}`;
}

/** The message a sender wrote, without the label the model reads. */
export function threadMessageBody(text: string, sender: ThreadMessageData): string {
  const label = threadMessageLabel(sender.relation, sender.sessionId);
  return text.startsWith(label) ? text.slice(label.length) : text;
}

function threadMessageLabel(relation: "parent" | "child", fromSessionId: string): string {
  return `Message from ${relation} thread ${fromSessionId}:\n\n`;
}
