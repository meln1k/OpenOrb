import {
  SESSION_THINKING_LEVELS,
  type SessionThinkingLevel,
} from "../../../protocol/src/thinking-level.ts";

export function supportedThinkingLevels(
  levels: readonly SessionThinkingLevel[],
): readonly SessionThinkingLevel[] {
  return SESSION_THINKING_LEVELS.filter((candidate) => levels.includes(candidate));
}

export function nextThinkingLevel(
  level: SessionThinkingLevel,
  supportedLevels: readonly SessionThinkingLevel[],
): SessionThinkingLevel {
  const levels = supportedThinkingLevels(supportedLevels);
  if (levels.length === 0) return level;
  const index = levels.indexOf(level);
  return levels[(index + 1) % levels.length]!;
}

export function clampThinkingLevel(
  level: SessionThinkingLevel | string,
  supportedLevels: readonly SessionThinkingLevel[],
): SessionThinkingLevel {
  const levels = supportedThinkingLevels(supportedLevels);
  const requestedIndex = SESSION_THINKING_LEVELS.findIndex((candidate) => candidate === level);
  if (requestedIndex === -1) return levels[0] ?? "off";
  for (let index = requestedIndex; index < SESSION_THINKING_LEVELS.length; index++) {
    const candidate = SESSION_THINKING_LEVELS[index]!;
    if (levels.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const candidate = SESSION_THINKING_LEVELS[index]!;
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? "off";
}

export function formatThinkingLevel(level: SessionThinkingLevel): string {
  return level === "xhigh" ? "extra high" : level;
}
