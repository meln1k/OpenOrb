import { assertEquals, assertFalse } from "@std/assert";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ExecutionEnv,
  FileError,
  type FileInfo,
  type FileKind,
} from "@earendil-works/pi-durable/env";
import type { Message } from "@earendil-works/pi-ai";
import {
  discoverRepositorySkills,
  repositorySkillsPrompt,
  shownRepositorySkills,
  SKILLS_PENDING_PROMPT,
} from "../app/cells/session/skills.ts";

const ROOT = "/workspace/.agents/skills";

/** A guest filesystem of files and symlinks that records every file read. */
function memoryGuest(files: Map<string, string>, symlinks: ReadonlySet<string> = new Set()) {
  const reads: string[] = [];
  const entries = (path: string): FileInfo[] | undefined => {
    const children = new Map<string, FileKind>();
    for (const file of files.keys()) {
      if (!file.startsWith(`${path}/`)) continue;
      const [name, ...rest] = file.slice(path.length + 1).split("/");
      const child = `${path}/${name}`;
      children.set(name!, symlinks.has(child) ? "symlink" : rest.length > 0 ? "directory" : "file");
    }
    if (children.size === 0) return undefined;
    return [...children].map(([name, kind]) => ({
      name,
      path: `${path}/${name}`,
      kind,
      size: kind === "file" ? new TextEncoder().encode(files.get(`${path}/${name}`)).length : 0,
      mtimeMs: 0,
    }));
  };
  const fake: Partial<ExecutionEnv> = {
    listDir: (path) => {
      const listed = entries(path);
      return Promise.resolve(
        listed === undefined
          ? { ok: false, error: new FileError("not_found", "missing", path) }
          : { ok: true, value: listed },
      );
    },
    readTextFile: (path) => {
      reads.push(path);
      const content = files.get(path);
      return Promise.resolve(
        content === undefined
          ? { ok: false, error: new FileError("not_found", "missing", path) }
          : { ok: true, value: content },
      );
    },
  };
  // SAFETY: discovery uses only listDir and readTextFile.
  return { env: fake as ExecutionEnv, reads };
}

Deno.test("repository skills read only guest metadata, support YAML, and exclude bodies", async () => {
  const first = `${ROOT}/alpha/SKILL.md`;
  const nested = `${ROOT}/group/beta/SKILL.md`;
  const files = new Map([
    [
      first,
      "\uFEFF---\r\nname: alpha\r\ndescription: >-\r\n  Use for A & B\r\n  with <tags>.\r\n---\r\nBODY MUST NOT BE IN THE CATALOG",
    ],
    [nested, '---\ndescription: "Quoted: description"\n---\nbody'],
    [`${ROOT}/alpha/scripts/attack.sh`, "do not read or execute"],
    [`${ROOT}/alpha/examples/extra/SKILL.md`, "do not read or execute"],
    [`${ROOT}/.hidden/SKILL.md`, "do not read or execute"],
    [`${ROOT}/node_modules/dependency/SKILL.md`, "do not read or execute"],
    ["/workspace/.pi/settings.json", "do not read or execute"],
    ["/root/.agents/skills/global/SKILL.md", "do not read or execute"],
  ]);
  const guest = memoryGuest(files);
  const skills = await discoverRepositorySkills(guest.env, BACKGROUND_CONTEXT);
  assertEquals(skills, [
    { name: "alpha", description: "Use for A & B with <tags>.", path: first },
    { name: "beta", description: "Quoted: description", path: nested },
  ]);
  assertEquals(guest.reads, [first, nested]);
  const prompt = repositorySkillsPrompt(skills);
  assertEquals(
    prompt,
    [
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
      "  <skill>",
      "    <name>alpha</name>",
      "    <description>Use for A &amp; B with &lt;tags&gt;.</description>",
      "    <location>/workspace/.agents/skills/alpha/SKILL.md</location>",
      "  </skill>",
      "  <skill>",
      "    <name>beta</name>",
      "    <description>Quoted: description</description>",
      "    <location>/workspace/.agents/skills/group/beta/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
    ].join("\n"),
  );
  assertEquals(repositorySkillsPrompt([]), "");
  assertFalse(prompt.includes("BODY MUST NOT"));
});

Deno.test("malformed, disabled, oversized and duplicate skills cannot replace valid skills", async () => {
  const files = new Map<string, string>();
  for (
    const [directory, metadata] of [
      ["a-valid", "name: valid\ndescription: accepted"],
      ["b-duplicate", "name: valid\ndescription: must not win"],
      ["disabled", "description: hidden\ndisable-model-invocation: true"],
      ["missing", "name: missing"],
      ["blank", 'description: "   "'],
      ["invalid-name", "name: ../escape\ndescription: no"],
      ["wrong-type", "description: [not, text]"],
      ["invalid-yaml", "description: ["],
      ["alias", "description: &cycle [*cycle]"],
      ["oversized", `description: ${"x".repeat(64 * 1024)}`],
    ]
  ) files.set(`${ROOT}/${directory}/SKILL.md`, `---\n${metadata}\n---\nbody`);
  const guest = memoryGuest(files);
  assertEquals(await discoverRepositorySkills(guest.env, BACKGROUND_CONTEXT), [
    { name: "valid", description: "accepted", path: `${ROOT}/a-valid/SKILL.md` },
  ]);
  assertFalse(guest.reads.includes(`${ROOT}/oversized/SKILL.md`), "oversized files are not read");
  assertEquals(await discoverRepositorySkills(memoryGuest(new Map()).env, BACKGROUND_CONTEXT), []);
});

Deno.test("discovery skips symlinks, bounds depth, and never truncates wide trees", async () => {
  const deep = `${ROOT}/${Array.from({ length: 9 }, (_, index) => `d${index}`).join("/")}`;
  const linked = memoryGuest(
    new Map([
      [`${ROOT}/linked/target/SKILL.md`, "---\ndescription: through a link\n---\n"],
      [`${deep}/SKILL.md`, "---\ndescription: too deep\n---\n"],
    ]),
    new Set([`${ROOT}/linked`]),
  );
  assertEquals(await discoverRepositorySkills(linked.env, BACKGROUND_CONTEXT), []);

  const files = new Map<string, string>();
  for (let index = 0; index < 600; index++) {
    const name = `skill-${String(index).padStart(3, "0")}`;
    files.set(`${ROOT}/${name}/SKILL.md`, `---\ndescription: ${name}\n---\nbody`);
  }
  const wide = memoryGuest(files);
  const skills = await discoverRepositorySkills(wide.env, BACKGROUND_CONTEXT);
  assertEquals(skills.length, 600);
  assertEquals(skills[599], {
    name: "skill-599",
    description: "skill-599",
    path: "/workspace/.agents/skills/skill-599/SKILL.md",
  });
  assertEquals(wide.reads.length, 600);
});

Deno.test("the shown catalog is replayed from the transcript's system messages", () => {
  const system = (sections: Record<string, string | null>): Message => ({
    role: "system",
    content: "",
    sections,
    timestamp: 0,
  });
  const tagged = (text: string) => `<repository-skills>\n${text}\n</repository-skills>`;
  const user: Message = { role: "user", content: "hi", timestamp: 0 };
  assertEquals(shownRepositorySkills([]), undefined);
  assertEquals(shownRepositorySkills([system({ openorb: "base" }), user]), undefined);
  assertEquals(
    shownRepositorySkills([system({ "repository-skills": tagged(SKILLS_PENDING_PROMPT) })]),
    undefined,
  );
  assertEquals(
    shownRepositorySkills([
      system({ "repository-skills": tagged(SKILLS_PENDING_PROMPT) }),
      user,
      system({ "repository-skills": tagged("catalog") }),
    ]),
    "catalog",
  );
  assertEquals(shownRepositorySkills([system({ "repository-skills": tagged("") })]), "");
  assertEquals(
    shownRepositorySkills([
      system({ "repository-skills": tagged("catalog") }),
      system({ "repository-skills": null }),
    ]),
    undefined,
  );
});
