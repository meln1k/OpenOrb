export const SESSION_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type SessionThinkingLevel = (typeof SESSION_THINKING_LEVELS)[number];
