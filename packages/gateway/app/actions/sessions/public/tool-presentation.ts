import { trySync } from "../../../../../result/src/index.ts";
import { any, parseSafe, record, string } from "remix/data-schema";
import type { IconName } from "../../../ui/public/components/icons.tsx";

interface ToolPresentation {
  readonly icon: IconName;
  /** The argument that says what a call did, shown in place of the raw arguments. */
  readonly argument: string;
  readonly label: (value: string) => string;
}

const TOOLS = new Map(
  Object.entries({
    bash: { icon: "terminal", argument: "command", label: (command) => command },
    read: { icon: "book-open-text", argument: "path", label: (path) => path },
    web_search: { icon: "globe", argument: "query", label: (query) => `Search: ${query}` },
    web_fetch: { icon: "globe", argument: "url", label: (url) => `Fetch: ${url}` },
  } satisfies Record<string, ToolPresentation>),
);

const argumentsSchema = record(string(), any());

export function toolIcon(toolName: string): IconName {
  return TOOLS.get(toolName)?.icon ?? "wrench";
}

/** A one-line label for a known tool's call, or undefined when its key argument is missing. */
export function toolLabel(toolName: string, argumentsText: string | undefined): string | undefined {
  const tool = TOOLS.get(toolName);
  if (tool === undefined || argumentsText === undefined) return undefined;
  const [value, parseError] = trySync(
    () => JSON.parse(argumentsText),
    () => true,
  );
  if (parseError !== undefined) return undefined;
  const parsed = parseSafe(argumentsSchema, value);
  if (!parsed.success) return undefined;
  const argument = parseSafe(string(), parsed.value[tool.argument]);
  return argument.success && argument.value.length > 0 ? tool.label(argument.value) : undefined;
}
