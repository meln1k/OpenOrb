import {
  type AgentToolResult,
  type EditOperations,
  type EditToolDetails,
  type EditToolInput,
  generateDiffString,
  generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { tryAsync } from "@openorb/result";

import { AgentEnvironmentError } from "../../environment/agent-environment.ts";

interface TextReplacement {
  readonly editIndex: number;
  readonly matchIndex: number;
  readonly matchLength: number;
  readonly newText: string;
}

interface LineSpan {
  readonly start: number;
  readonly end: number;
}

interface AppliedEditsResult {
  readonly baseContent: string;
  readonly newContent: string;
}

interface TextMatch {
  readonly found: boolean;
  readonly index: number;
  readonly matchLength: number;
  readonly usedFuzzyMatch: boolean;
}

interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export async function executePiEdit(
  operations: EditOperations,
  { path, edits }: EditToolInput,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<EditToolDetails | undefined>> {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new AgentEnvironmentError(
      "Edit tool input is invalid. edits must contain at least one replacement.",
      undefined,
    );
  }

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new AgentEnvironmentError("Operation aborted.", signal.reason);
    }
  };

  throwIfAborted();
  const [, accessError] = await tryAsync(operations.access(path), (cause) => {
    const message = cause instanceof Error && "code" in cause
      ? `Error code: ${cause.code}`
      : String(cause);
    return new AgentEnvironmentError(`Could not edit file: ${path}. ${message}.`, cause);
  });
  if (accessError !== undefined) {
    throwIfAborted();
    throw accessError;
  }
  throwIfAborted();

  const rawContent = (await operations.readFile(path)).toString("utf-8");
  throwIfAborted();
  const { bom, text: content } = stripBom(rawContent);
  const originalEnding = detectLineEnding(content);
  const normalizedContent = normalizeToLf(content);
  const { baseContent, newContent } = applyEdits(normalizedContent, edits, path);
  throwIfAborted();

  await operations.writeFile(
    path,
    bom + restoreLineEndings(newContent, originalEnding),
  );
  throwIfAborted();
  const diff = generateDiffString(baseContent, newContent);
  return {
    content: [{
      type: "text",
      text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
    }],
    details: {
      diff: diff.diff,
      patch: generateUnifiedPatch(path, baseContent, newContent),
      ...(diff.firstChangedLine === undefined ? {} : { firstChangedLine: diff.firstChangedLine }),
    },
  };
}

// Pi does not expose its matcher as public API. Keep these semantics aligned with the
// pinned Pi version so replacing its host-bound executor does not change edit behavior.
function applyEdits(
  content: string,
  edits: EditToolInput["edits"],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));

  for (let index = 0; index < normalizedEdits.length; index++) {
    if (normalizedEdits[index]!.oldText.length === 0) {
      throw emptyOldTextError(path, index, normalizedEdits.length);
    }
  }

  const useFuzzyContent = normalizedEdits.some((edit) =>
    findText(content, edit.oldText).usedFuzzyMatch
  );
  const replacementContent = useFuzzyContent ? normalizeForFuzzyMatch(content) : content;
  const replacements: TextReplacement[] = normalizedEdits.map((edit, index) => {
    const match = findText(replacementContent, edit.oldText);
    if (!match.found) throw notFoundError(path, index, normalizedEdits.length);

    const occurrences = countOccurrences(replacementContent, edit.oldText);
    if (occurrences > 1) {
      throw duplicateError(path, index, normalizedEdits.length, occurrences);
    }
    return {
      editIndex: index,
      matchIndex: match.index,
      matchLength: match.matchLength,
      newText: edit.newText,
    };
  }).sort((left, right) => left.matchIndex - right.matchIndex);

  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1]!;
    const current = replacements[index]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new AgentEnvironmentError(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
        undefined,
      );
    }
  }

  const newContent = useFuzzyContent
    ? applyReplacementsPreservingLines(content, replacementContent, replacements)
    : applyReplacements(replacementContent, replacements);
  if (content === newContent) throw noChangeError(path, normalizedEdits.length);
  return { baseContent: content, newContent };
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  return lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { readonly bom: string; readonly text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function findText(content: string, oldText: string): TextMatch {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
    };
  }

  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = normalizeForFuzzyMatch(content).indexOf(fuzzyOldText);
  return fuzzyIndex === -1 ? { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false } : {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
  };
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function lineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function replacementLineRange(
  lines: readonly LineSpan[],
  replacement: TextReplacement,
): LineRange {
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  const startLine = lines.findIndex((line) =>
    replacement.matchIndex >= line.start && replacement.matchIndex < line.end
  );
  if (startLine === -1) {
    throw new AgentEnvironmentError(
      "Replacement range is outside the base content.",
      undefined,
    );
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) endLine++;
  if (endLine >= lines.length) {
    throw new AgentEnvironmentError(
      "Replacement range is outside the base content.",
      undefined,
    );
  }
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(
  content: string,
  replacements: readonly TextReplacement[],
  offset = 0,
): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]!;
    const matchIndex = replacement.matchIndex - offset;
    result = result.substring(0, matchIndex) + replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

function applyReplacementsPreservingLines(
  originalContent: string,
  baseContent: string,
  replacements: readonly TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = lineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new AgentEnvironmentError(
      "Cannot preserve unchanged lines because the base content has a different line count.",
      undefined,
    );
  }

  const groups: Array<{
    startLine: number;
    endLine: number;
    replacements: TextReplacement[];
  }> = [];
  for (const replacement of replacements) {
    const range = replacementLineRange(baseLines, replacement);
    const current = groups.at(-1);
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStart = baseLines[group.startLine]!.start;
    const groupEnd = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(
      baseContent.slice(groupStart, groupEnd),
      group.replacements,
      groupStart,
    );
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

function notFoundError(path: string, index: number, total: number): AgentEnvironmentError {
  return total === 1
    ? new AgentEnvironmentError(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
      undefined,
    )
    : new AgentEnvironmentError(
      `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      undefined,
    );
}

function duplicateError(
  path: string,
  index: number,
  total: number,
  count: number,
): AgentEnvironmentError {
  return total === 1
    ? new AgentEnvironmentError(
      `Found ${count} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
      undefined,
    )
    : new AgentEnvironmentError(
      `Found ${count} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      undefined,
    );
}

function emptyOldTextError(path: string, index: number, total: number): AgentEnvironmentError {
  return total === 1
    ? new AgentEnvironmentError(`oldText must not be empty in ${path}.`, undefined)
    : new AgentEnvironmentError(
      `edits[${index}].oldText must not be empty in ${path}.`,
      undefined,
    );
}

function noChangeError(path: string, total: number): AgentEnvironmentError {
  return total === 1
    ? new AgentEnvironmentError(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
      undefined,
    )
    : new AgentEnvironmentError(
      `No changes made to ${path}. The replacements produced identical content.`,
      undefined,
    );
}
