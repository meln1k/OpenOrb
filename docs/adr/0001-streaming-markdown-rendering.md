# Render each streamed Markdown snapshot with Marked

**Status:** Accepted

Assistant responses use Marked's GFM grammar and render its tokens as native Remix JSX. Each browser
render lexes the complete current assistant text. Marked, rather than application-owned incremental
state, decides how newly appended source affects earlier Markdown.

## Contract

- The session transcript owns the exact accumulated response text.
- The runner and gateway relay lossless, low-latency text deltas without inferring Markdown blocks.
- The browser applies every event to transcript state synchronously, but schedules at most one JSX
  update per animation frame. No Markdown work occurs when no transcript update is pending.
- During an update, the renderer lexes the complete current response with Marked and projects the
  resulting tokens to native Remix JSX.
- Top-level blocks use stable positional keys so Remix can reconcile unchanged DOM. This is a
  rendering optimization, not a promise that earlier Markdown is immutable.

Later input may reinterpret any earlier source when the Markdown grammar requires it. For example,
an unfinished paragraph may become a Setext heading or table, and text surrounding a thematic break
may become one paragraph or heading. Every visible snapshot reflects a one-shot Marked parse of the
current source, independent of how transport deltas were batched.

## Rendering policy

| Marked token                           | Rendering behavior                                                         |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Paragraph or text                      | Render the current inline token tree.                                      |
| ATX or Setext heading                  | Render the current heading and inline content.                             |
| Fenced or indented code                | Render current content, including an unfinished long block.                |
| GFM table                              | Render once Marked recognizes the delimiter row.                           |
| Ordered, unordered, or task list       | Render the current list and disabled task controls.                        |
| Blockquote                             | Render the recursive token tree.                                           |
| Reference definition                   | Do not render; Marked resolves references elsewhere in the current source. |
| Raw HTML                               | Render escaped source in a code shell; never mount it as DOM.              |
| Thematic break and other atomic tokens | Render Marked's current token.                                             |

## Dialect and safety

- Supported syntax is Marked GFM with `breaks: false`.
- Reference links and images use Marked's document-level definitions.
- Front matter, footnotes, math, Mermaid, directives, and unconfigured extensions are plain Markdown
  text.
- Raw HTML is always escaped. Scriptable markup is never mounted.
- Links allow relative and fragment destinations plus `http`, `https`, and `mailto`; unsafe or
  obfuscated schemes are rejected. External links do not gain opener access.
- Images do not create `<img>` elements; they render as labeled safe links. Task-list controls are
  disabled. Code is displayed but not executed.
- Code and table containers own horizontal overflow so streaming content cannot widen the session
  page.

## Completion, correction, and interruptions

Completion changes only streaming presentation such as the cursor. It does not invoke a separate
parser path. An authoritative correction is rendered from its complete current text without needing
to reset Markdown-local state.

A temporary event-stream interruption does not complete the response. The browser preserves its
canonical transcript until replay or an authoritative terminal event arrives.

## Performance decision

Lexing is linear in the current response length and runs no faster than the browser's paint cadence.
In practice it runs at the lesser of stream-event frequency and display refresh rate, and multiple
events received before a frame produce one render. The previous active-suffix design already had the
same worst case for a long paragraph, code block, table, list, or blockquote. The simpler one-shot
path is preferred unless measurement shows complete-response parsing to be a real bottleneck.

## Rejected alternatives

- **Commit all top-level tokens except the last:** invalid. Future source can merge or reinterpret
  multiple earlier Marked tokens, so streamed output can diverge from one-shot output.
- **Infer safe commit boundaries:** retains a second state machine and a correctness obligation that
  Marked does not expose as an API.
- **Coalesce complete lines in the worker:** moves presentation policy into transport and does not
  resolve multi-line Markdown ambiguity.
- **Hide unresolved Markdown or wait for completion:** avoids reinterpretation but makes ordinary
  prose and long structured blocks arrive in large jumps.

## Verification obligations

Tests must cover progressive paragraphs, long incomplete structured blocks, grammar cases where
appended text reinterprets multiple earlier tokens, standard GFM references, raw-HTML and URL
safety, and code/table overflow at representative desktop and mobile widths.
