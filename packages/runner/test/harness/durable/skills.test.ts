import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { EnvironmentState } from "@openorb/protocol/runner-api";
import { Effect, SubscriptionRef } from "effect";
import {
  discoverRepositorySkills,
  repositorySkillsPrompt,
} from "../../../src/harness/durable/skills.ts";
import { fixtureHarness, memoryGuest, optionsFor, until } from "./helpers.ts";

const ROOT = "/workspace/.agents/skills";
const encoder = new TextEncoder();

Deno.test({
  name: "repository skills read only guest metadata, support YAML, and exclude scripts and bodies",
  permissions: { read: false, write: false, env: false, sys: false, run: false, net: false },
  async fn() {
    const guest = memoryGuest();
    const first = `${ROOT}/alpha/SKILL.md`;
    const nested = `${ROOT}/group/beta/SKILL.md`;
    guest.files.set(
      first,
      encoder.encode(
        "\uFEFF---\r\nname: alpha\r\ndescription: >-\r\n  Use for A & B\r\n  with <tags>.\r\n---\r\nBODY MUST NOT BE IN THE CATALOG",
      ),
    );
    guest.files.set(nested, encoder.encode('---\ndescription: "Quoted: description"\n---\nbody'));
    for (
      const path of [
        `${ROOT}/alpha/scripts/attack.sh`,
        `${ROOT}/alpha/examples/extra/SKILL.md`,
        `${ROOT}/.hidden/SKILL.md`,
        `${ROOT}/node_modules/dependency/SKILL.md`,
        "/workspace/.pi/settings.json",
        "/root/.agents/skills/global/SKILL.md",
      ]
    ) guest.files.set(path, encoder.encode("do not read or execute"));
    const skills = await Effect.runPromise(discoverRepositorySkills(guest.environment));
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
  },
});

Deno.test("malformed, disabled, oversized and duplicate repository skills cannot replace valid skills", async () => {
  const guest = memoryGuest();
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
  ) {
    guest.files.set(`${ROOT}/${directory}/SKILL.md`, encoder.encode(`---\n${metadata}\n---\nbody`));
  }
  assertEquals(await Effect.runPromise(discoverRepositorySkills(guest.environment)), [
    { name: "valid", description: "accepted", path: `${ROOT}/a-valid/SKILL.md` },
  ]);
  assertEquals(await Effect.runPromise(discoverRepositorySkills(memoryGuest().environment)), []);
});

Deno.test("repository discovery bounds cyclic directories without truncating wide trees", async () => {
  const guest = memoryGuest();
  let lists = 0;
  const directory = {
    ...guest.environment,
    stat: () =>
      Effect.succeed({ isDirectory: () => true, isFile: () => false, size: 0, mtimeMs: 0 }),
    listDirectory: () =>
      Effect.sync(() => {
        lists++;
        return ["cycle"];
      }),
  };
  assertEquals(await Effect.runPromise(discoverRepositorySkills(directory)), []);
  assertEquals(lists, 9, "symlink-like cycles stop at the depth boundary");

  const wide = memoryGuest();
  for (let index = 0; index < 600; index++) {
    const name = `skill-${String(index).padStart(3, "0")}`;
    wide.files.set(
      `${ROOT}/${name}/SKILL.md`,
      encoder.encode(`---\ndescription: ${name}\n---\nbody`),
    );
  }
  const skills = await Effect.runPromise(discoverRepositorySkills(wide.environment));
  assertEquals(skills.length, 600);
  assertEquals(skills[599], {
    name: "skill-599",
    description: "skill-599",
    path: "/workspace/.agents/skills/skill-599/SKILL.md",
  });
  assertEquals(wide.reads.length, 600);
});

function catalog(context: TranscriptContext): string {
  return context.messages.filter((message) => message.role === "system")
    .map((message) => message.sections?.["repository-skills"])
    .findLast((section) => section !== undefined) ?? "";
}

Deno.test("skills arrive after project readiness, update the next request, and refresh across reopen", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const guest = memoryGuest();
  const states = await Effect.runPromise(SubscriptionRef.make<EnvironmentState>("starting"));
  const path = `${ROOT}/project/SKILL.md`;
  guest.files.set(
    path,
    encoder.encode("---\nname: project\ndescription: original guidance\n---\nFULL SKILL BODY"),
  );
  const options = {
    ...optionsFor(directory, guest.environment),
    get environmentState() {
      return states.value;
    },
    environmentStates: SubscriptionRef.changes(states),
  };
  const prompts: string[] = [];
  const first = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  fixture.faux.setResponses([
    (context) => {
      prompts.push(catalog(context));
      return first.promise;
    },
    (context) => {
      prompts.push(catalog(context));
      return fauxAssistantMessage("used skill");
    },
    (context) => {
      prompts.push(catalog(context));
      return fauxAssistantMessage("refreshed");
    },
  ]);
  let opened = await fixture.open(options);
  try {
    await Effect.runPromise(opened.session.submit("work during boot", "boot"));
    await until(() => fixture.faux.state.callCount === 1);
    assertEquals(guest.reads, []);
    assertFalse(prompts[0]!.includes("original guidance"));
    await Effect.runPromise(SubscriptionRef.set(states, "running"));
    await until(() => guest.reads.length === 1);
    first.resolve(fauxAssistantMessage(fauxToolCall("read", { path }), { stopReason: "toolUse" }));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    assertStringIncludes(prompts[1]!, "original guidance");
    assertFalse(prompts[1]!.includes("FULL SKILL BODY"));
    assertStringIncludes(JSON.stringify(opened.session.view), "FULL SKILL BODY");
    assertEquals(guest.reads, [path, path], "metadata discovery then demand loading through read");
    await opened.close();
    guest.files.set(
      path,
      encoder.encode("---\nname: project\ndescription: changed guidance\n---\nbody"),
    );
    opened = await fixture.open(options);
    await until(() => guest.reads.length === 3);
    await Effect.runPromise(opened.session.submit("after reopen", "reopen"));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    assertStringIncludes(prompts[2]!, "changed guidance");
    assertFalse(prompts[2]!.includes("original guidance"));
  } finally {
    first.resolve(fauxAssistantMessage("cleanup"));
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("hung skill discovery does not block model work; stop and close cancel it and restart reloads", async () => {
  const directory = await Deno.makeTempDir();
  const fixture = fixtureHarness();
  const guest = memoryGuest();
  const states = await Effect.runPromise(SubscriptionRef.make<EnvironmentState>("running"));
  let hang = true;
  let scans = 0;
  let cancelled = 0;
  const path = `${ROOT}/restart/SKILL.md`;
  guest.files.set(path, encoder.encode("---\ndescription: restart guidance\n---\nbody"));
  const options = {
    ...optionsFor(directory, {
      ...guest.environment,
      listDirectory: (path: string) =>
        Effect.suspend(() => {
          scans++;
          return hang
            ? Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
              cancelled++;
            })))
            : guest.environment.listDirectory(path);
        }),
    }),
    get environmentState() {
      return states.value;
    },
    environmentStates: SubscriptionRef.changes(states),
  };
  const prompts: string[] = [];
  fixture.faux.setResponses(Array.from({ length: 3 }, () => (context: TranscriptContext) => {
    prompts.push(catalog(context));
    return fauxAssistantMessage("still responsive");
  }));
  const opened = await fixture.open(options);
  try {
    await until(() => scans === 1);
    await Effect.runPromise(opened.session.submit("during scan", "scanning"));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    await Effect.runPromise(SubscriptionRef.set(states, "stopped"));
    await until(() => cancelled === 1);
    hang = false;
    await Effect.runPromise(SubscriptionRef.set(states, "running"));
    await until(() => guest.reads.length === 1);
    await Effect.runPromise(opened.session.submit("after restart", "restart"));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    assertStringIncludes(prompts[1]!, "restart guidance");
    await Effect.runPromise(SubscriptionRef.set(states, "stopped"));
    await Effect.runPromise(opened.session.submit("while stopped", "stopped"));
    await until(() => !opened.session.view.docs["pi.live"]?.run);
    assertFalse(prompts[2]!.includes("restart guidance"));
    assertStringIncludes(prompts[2]!, "when the guest project is ready");
    hang = true;
    const previousScans = scans;
    await Effect.runPromise(SubscriptionRef.set(states, "running"));
    await until(() => scans > previousScans);
    await opened.close();
    assertEquals(cancelled, 2);
  } finally {
    await opened.close();
    await Deno.remove(directory, { recursive: true });
  }
});
