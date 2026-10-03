import { Effect, Option, Schema } from "effect";
import { posix } from "node:path";
import { parse } from "@std/yaml";
import { trySync } from "@openorb/result";
import type { AgentEnvironment } from "../../environment/agent-environment.ts";

const SKILLS_DIRECTORY = "/workspace/.agents/skills";
const MAX_SCAN_DEPTH = 8;
const MAX_SKILL_BYTES = 64 * 1024;

const SkillMetadata = Schema.Struct({
  name: Schema.optionalKey(Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.isMaxLength(64)),
  )),
  description: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  "disable-model-invocation": Schema.optionalKey(Schema.Boolean),
});

export interface RepositorySkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

/** Only passive guest metadata is read. No host resource loader or script execution. */
export const discoverRepositorySkills = Effect.fn("discoverRepositorySkills")(function* (
  guest: AgentEnvironment,
) {
  const skills = new Map<string, RepositorySkill>();
  const directories = [{ path: SKILLS_DIRECTORY, depth: 0 }];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!;
    const listing = yield* Effect.result(guest.listDirectory(directory.path));
    if (listing._tag === "Failure") continue;
    const names = listing.success.sort();
    if (names.includes("SKILL.md")) {
      const path = posix.join(directory.path, "SKILL.md");
      const bytes = yield* Effect.result(guest.readFile(path, { maxBytes: MAX_SKILL_BYTES }));
      const skill = bytes._tag === "Success"
        ? parseSkill(new TextDecoder().decode(bytes.success), path)
        : undefined;
      if (skill) {
        if (!skills.has(skill.name)) skills.set(skill.name, skill);
        else {yield* Effect.logWarning(
            `Duplicate repository skill skipped: ${JSON.stringify(path)}`,
          );}
      } else {
        yield* Effect.logWarning(
          `Invalid, disabled, or unreadable repository skill skipped: ${JSON.stringify(path)}`,
        );
      }
      // A skill owns its supporting directories; do not discover examples as extra skills.
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = posix.join(directory.path, name);
      const stat = yield* Effect.result(guest.stat(path));
      if (
        stat._tag === "Success" && stat.success.isDirectory() && directory.depth < MAX_SCAN_DEPTH
      ) {
        directories.push({ path, depth: directory.depth + 1 });
      }
    }
  }
  return [...skills.values()];
});

function parseSkill(content: string, path: string): RepositorySkill | undefined {
  const frontmatter = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")
    .match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (frontmatter === undefined) return undefined;
  const [metadata, error] = trySync(() => parse(frontmatter, { schema: "core" }), () => true);
  if (error !== undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(SkillMetadata)(metadata);
  if (Option.isNone(decoded)) return undefined;
  const { name, description } = decoded.value;
  if (decoded.value["disable-model-invocation"]) return undefined;
  const effectiveName = name ?? posix.basename(posix.dirname(path));
  if (!Schema.is(SkillMetadata.fields.name.schema)(effectiveName)) return undefined;
  if (!description.trim()) return undefined;
  return { name: effectiveName, description, path };
}

export function repositorySkillsPrompt(skills: readonly RepositorySkill[]): string {
  if (skills.length === 0) return "";
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...skills.map((skill) =>
      [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        `    <location>${escapeXml(skill.path)}</location>`,
        "  </skill>",
      ].join("\n")
    ),
    "</available_skills>",
  ].join("\n");
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
