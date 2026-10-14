import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { trySync } from "@openorb/result";
import { parse } from "@jsr/std__yaml";
import { Option, Schema } from "effect";

// Repository skills (ADR 0006): the Session reads passive SKILL.md metadata from the guest over
// ExecutionEnv. Nothing in the guest is executed and no host loader is involved.

const SKILLS_DIRECTORY = "/workspace/.agents/skills";
const MAX_SCAN_DEPTH = 8;
const MAX_SKILL_BYTES = 64 * 1024;

export const SKILLS_PENDING_PROMPT =
  "Repository skills will be discovered when the guest project is ready.";
/** The system prompt section key; pi-durable renders it as `<repository-skills>…</…>`. */
export const REPOSITORY_SKILLS_SECTION = "repository-skills";

const SkillName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(64),
);
const SkillMetadata = Schema.Struct({
  name: Schema.optionalKey(SkillName),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  "disable-model-invocation": Schema.optionalKey(Schema.Boolean),
});

export interface RepositorySkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

/**
 * Unreadable directories and invalid or duplicate skills are skipped, never fatal. Only real
 * directories are descended, so symlink cycles cannot recur; depth bounds the rest.
 */
export async function discoverRepositorySkills(
  env: ExecutionEnv,
  context: Context,
): Promise<RepositorySkill[]> {
  const skills = new Map<string, RepositorySkill>();
  const directories = [{ path: SKILLS_DIRECTORY, depth: 0 }];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!;
    const listing = await env.listDir(directory.path, context);
    if (!listing.ok) continue;
    const entries = listing.value.toSorted((a, b) => (a.name < b.name ? -1 : 1));
    const manifest = entries.find((entry) => entry.name === "SKILL.md" && entry.kind === "file");
    if (manifest !== undefined) {
      const path = `${directory.path}/SKILL.md`;
      const skill =
        manifest.size <= MAX_SKILL_BYTES ? await readSkill(env, path, context) : undefined;
      if (skill !== undefined && !skills.has(skill.name)) skills.set(skill.name, skill);
      // A skill owns its supporting directories; examples inside it are not extra skills.
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.kind === "directory" && directory.depth < MAX_SCAN_DEPTH) {
        directories.push({ path: `${directory.path}/${entry.name}`, depth: directory.depth + 1 });
      }
    }
  }
  return [...skills.values()];
}

async function readSkill(
  env: ExecutionEnv,
  path: string,
  context: Context,
): Promise<RepositorySkill | undefined> {
  const content = await env.readTextFile(path, context);
  return content.ok ? parseSkill(content.value, path) : undefined;
}

export function parseSkill(content: string, path: string): RepositorySkill | undefined {
  const frontmatter = content
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (frontmatter === undefined) return undefined;
  const [metadata, error] = trySync(
    () => parse(frontmatter, { schema: "core" }),
    () => true,
  );
  if (error !== undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(SkillMetadata)(metadata);
  if (Option.isNone(decoded)) return undefined;
  const { name, description } = decoded.value;
  if (decoded.value["disable-model-invocation"]) return undefined;
  const directory = path.slice(0, path.lastIndexOf("/"));
  const effectiveName = name ?? directory.slice(directory.lastIndexOf("/") + 1);
  if (!Schema.is(SkillName)(effectiveName) || !description.trim()) return undefined;
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
      ].join("\n"),
    ),
    "</available_skills>",
  ].join("\n");
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * The catalog the model has already been shown, replayed from the conversation's system messages.
 * The transcript is the only record of a loaded catalog; `undefined` means none was shown yet.
 */
export function shownRepositorySkills(messages: readonly Message[]): string | undefined {
  let shown: string | undefined;
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;
    const section = message.sections[REPOSITORY_SKILLS_SECTION];
    if (section !== undefined) shown = section ?? undefined;
  }
  const open = `<${REPOSITORY_SKILLS_SECTION}>\n`;
  const close = `\n</${REPOSITORY_SKILLS_SECTION}>`;
  if (shown === undefined || !shown.startsWith(open) || !shown.endsWith(close)) return undefined;
  const catalog = shown.slice(open.length, shown.length - close.length);
  return catalog === SKILLS_PENDING_PROMPT ? undefined : catalog;
}
