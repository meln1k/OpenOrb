import { assertEquals, assertNotMatch, assertStringIncludes } from "@std/assert";
import { renderToString } from "remix/ui/server";

import { AssistantMarkdown } from "@/app/ui/session/session-markdown.tsx";

const SESSION_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c10";
const ARTIFACT_ID = "01989d78-65ee-7f6a-a97e-0f16ad134c11";

Deno.test("renders the complete current source through Marked while streaming", async () => {
  const paragraph = await renderMarkdown("Candidate heading", false);
  assertStringIncludes(paragraph, 'data-markdown-kind="paragraph"');
  assertStringIncludes(paragraph, ">Candidate heading</p>");
  assertStringIncludes(paragraph, "data-markdown-streaming-cursor");

  const heading = await renderMarkdown("Candidate heading\n---", false);
  assertStringIncludes(heading, 'data-markdown-kind="heading"');
  assertStringIncludes(heading, ">Candidate heading</h2>");
  assertNotMatch(heading, /data-markdown-kind="paragraph"/);
});

Deno.test("renders long structured blocks before completion", async () => {
  const fixtures = [
    {
      source: "# Streaming **heading**",
      kind: "heading",
      expectedHtml: "<strong>heading</strong>",
    },
    {
      source: "```ts\nconst partial = true",
      kind: "code",
      expectedHtml: "const partial = true",
    },
    {
      source: "| Name | Value |\n| --- | ---: |\n| one | 1",
      kind: "table",
      expectedHtml: "<table>",
    },
    {
      source: "- first\n- second",
      kind: "list",
      expectedHtml: "<ul>",
    },
    {
      source: "> quoted **content**",
      kind: "blockquote",
      expectedHtml: "<blockquote>",
    },
  ] as const;

  for (const fixture of fixtures) {
    const html = await renderMarkdown(fixture.source, false);
    assertStringIncludes(html, `data-markdown-kind="${fixture.kind}"`);
    assertStringIncludes(html, fixture.expectedHtml);
    assertStringIncludes(html, "data-markdown-streaming-cursor");
  }
});

Deno.test("reparses earlier tokens when appended Markdown changes their meaning", async () => {
  const thematicBreakPrefix = await renderMarkdown("a\n***", false);
  assertStringIncludes(thematicBreakPrefix, 'data-markdown-block-count="2"');
  assertStringIncludes(thematicBreakPrefix, 'data-markdown-kind="hr"');

  const paragraph = await renderMarkdown("a\n***x", true);
  assertStringIncludes(paragraph, 'data-markdown-block-count="1"');
  assertStringIncludes(paragraph, 'data-markdown-kind="paragraph"');
  assertStringIncludes(paragraph, "***x</p>");
  assertNotMatch(paragraph, /data-markdown-kind="hr"/);

  const setextHeading = await renderMarkdown("a\n***\na\n---", true);
  assertStringIncludes(setextHeading, 'data-markdown-block-count="1"');
  assertStringIncludes(setextHeading, 'data-markdown-kind="heading"');
  assertNotMatch(setextHeading, /data-markdown-kind="hr"/);
});

Deno.test("renders safe GFM tokens directly through Remix JSX", async () => {
  const html = await renderMarkdown(
    `# Result

**Bold** and [safe](https://example.com).

| Name | Value |
| --- | --- |
| answer | \`42\` |

- [x] complete
- [ ] pending

<script>alert("unsafe")</script>

[unsafe](javascript:alert(1))

![diagram](https://example.com/diagram.png)`,
    true,
  );

  assertStringIncludes(html, ">Result</h1>");
  assertStringIncludes(html, "<strong>Bold</strong>");
  assertStringIncludes(html, 'href="https://example.com"');
  assertStringIncludes(html, "<table>");
  assertStringIncludes(html, "<code>42</code>");
  assertEquals(html.match(/<input\b/g)?.length, 2);
  assertStringIncludes(html, 'aria-label="Completed task"');
  assertStringIncludes(html, 'aria-label="Incomplete task"');
  assertStringIncludes(html, '&lt;script&gt;alert("unsafe")&lt;/script&gt;');
  assertStringIncludes(html, ">Image: diagram</a>");
  assertNotMatch(html, /href="javascript:/);
  assertNotMatch(html, /<img\b/);
  assertNotMatch(html, /<script>alert/);
  assertNotMatch(html, /<span data-markdown-streaming-cursor/);
});

Deno.test("lets Marked resolve reference links from the complete current source", async () => {
  const prefix = await renderMarkdown("Read [the guide][guide].", false);
  assertNotMatch(prefix, /href="https:\/\/example.com\/guide"/);

  const completed = await renderMarkdown(
    "Read [the guide][guide] and ![diagram][guide].\n\n[guide]: https://example.com/guide",
    true,
  );
  assertEquals(completed.match(/href="https:\/\/example.com\/guide"/g)?.length, 2);
  assertStringIncludes(completed, ">the guide</a>");
  assertStringIncludes(completed, ">Image: diagram</a>");
  assertNotMatch(completed, /\[guide\]:/);
  assertNotMatch(completed, /<img\b/);
});

Deno.test("renders only published session media inline", async () => {
  const html = await renderMarkdown(
    `![Build result](openorb-artifact:image:${ARTIFACT_ID})

![Demo](openorb-artifact:video:${ARTIFACT_ID})

![Invalid](openorb-artifact:image:not-an-id)

![Remote](https://example.com/tracker.png)`,
    true,
  );

  const href = `/api/sessions/${SESSION_ID}/artifacts/${ARTIFACT_ID}`;
  assertStringIncludes(html, `data-published-media="image"`);
  assertStringIncludes(html, `<img src="${href}" alt="Build result" loading="lazy" />`);
  assertStringIncludes(html, `data-published-media="video"`);
  assertStringIncludes(html, `<video src="${href}" title="Demo" controls preload="metadata"`);
  assertEquals(html.match(/<img\b/g)?.length, 1);
  assertEquals(html.match(/<video\b/g)?.length, 1);
  assertStringIncludes(html, "Image: Invalid");
  assertStringIncludes(html, ">Image: Remote</a>");
});

async function renderMarkdown(text: string, completed: boolean): Promise<string> {
  return await renderToString(
    <AssistantMarkdown text={text} completed={completed} sessionId={SESSION_ID} />,
  );
}
