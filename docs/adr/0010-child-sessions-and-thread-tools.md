# Child Sessions and thread tools

**Status:** Accepted

The agent gets four OpenOrb-owned tools modelled on Amp's thread tools: `create_thread`,
`send_thread_message`, `get_thread_status`, and `read_thread`. They run in the Session Durable
Object, like `web_search`, and reach other Sessions only through native RPC between Session Durable
Objects of the same gateway. A thread is a Session; the tools keep Amp's names so prompts written for
Amp carry over.

Everything the agent reads says "thread": the system prompt, tool descriptions, tool results and
errors, and the label on a message from another thread. One line of the system prompt tells the
agent that OpenOrb's interface calls threads sessions and that a thread URL is
`/app/sessions/<thread ID>`, so it can follow a user who says either. Code, persistence, the browser,
and these documents keep the Session vocabulary of `CONTEXT.md`.

## Child Sessions

`create_thread` creates a **Child Session**: a Session another Session's agent created. Children
nest one level deep. A Session with a parent has no `create_thread` tool, and the Workspace refuses
a catalog entry whose parent itself has a parent, so neither a confused agent nor a crafted call can
build a deeper tree. A Session has at most 100 children at a time, enforced in the same catalog
check; deleting a child frees its place.

A child inherits the parent's provider and placement (the same runner, or the Sandbox), project,
Guest Credential Opt-in, orb size, model, and current thinking level. A project child clones the
project's original ref onto its own branch, `<parent branch>-child-<first 8 characters of its ID>`,
so siblings never share a branch. It cannot see the parent's uncommitted or unpushed work; the
parent says in the prompt what the child needs. The child's initial prompt is the parent's prompt
labelled with the parent's Session ID.

The child's ID is a UUIDv5 of the parent's Session ID and the tool call ID, so a repeated call starts
the same child once: Session creation and the catalog entry both accept a repeat. Children start
through the same path as a Session the user starts from the browser. The catalog entry, with its
`parentSessionId`, is written first, so a Session that fails to start stays visible and deletable.
It is removed only when the Session confirms it holds no record; after an ambiguous failure, which
may have left the Session running, it is kept. The sidebar nests children under their parent behind
a toggle that shows their count. Deleting a parent leaves its children in place, and the sidebar
then lists them at the top level. Runner admission
checks are not repeated for a child: it uses its parent's runner, which enforces its own capacity.

## Access

Each Session records in its own SQLite storage (`openorb_thread_access`) the Sessions it may reach,
and its parent in its Session record:

| Target                              | get_thread_status, read_thread | send_thread_message |
| ----------------------------------- | ------------------------------ | ------------------- |
| A Child Session it created          | yes                            | yes                 |
| Its parent                          | no                             | yes                 |
| A Session whose URL the user pasted | yes                            | no                  |
| Any other Session                   | no                             | no                  |

A Session URL is `http(s)://<any host>/app/sessions/<id>`, or one of its subpages, in a prompt the
user submitted from the browser: an initial prompt or a follow-up. The grant lasts for the
Session's lifetime. Every prompt names its origin: the browser marks the user's prompts, and only
those grant access. A child's initial prompt has its parent as origin, and messages from other
Sessions are admitted through a separate RPC method that never records grants, so no agent can give
itself or another agent access. Naming a Session in a tool argument grants nothing.

Every call also requires the target to be in the caller's Workspace catalog, so a deleted Session or
a pasted URL from another Workspace is not found. The target checks the Workspace ID the caller
sends, and a recipient of a message checks that the sender is its parent or one of its children. A
target that is not accessible reads as "not found", whether or not it exists.

## Messages

`send_thread_message` admits the message to the recipient like a prompt, labelled with the sender's
relation and Session ID, or as a follow-up when the recipient is busy, and starts its environment
when it is stopped. It returns at once; a reply is another `send_thread_message` from the recipient.
The request ID is derived from the sender's Session ID and tool call ID, so a repeated delivery is
admitted once.

The model reads the labelled prompt, but the recipient's transcript places it as an
`openorb.thread-message` entry naming the sender's relation, Session ID, and Initial Prompt Preview,
so the browser shows it as a message from that Session, linked to it, instead of as the user's. A
child's initial prompt is such an entry from its parent; the child's own Initial Prompt Preview is
the parent's prompt without the label.

## Reading

`get_thread_status` returns the target's lifecycle state and its newest messages, shortened.

`read_thread` takes a question and a `context`, as Amp's does. The target renders its transcript as
text: user and assistant messages, tool calls and results truncated, thinking, images, and system
messages left out, bounded to its newest 2,000,000 characters. `current` renders the active context
window; `full`, the default, renders the whole history, including what compaction replaced. The
calling Session then answers the question with its own model and Workspace credentials:

- A transcript that fits in half the model's context window, up to 400,000 characters, is answered
  in one request.
- A longer one is split into pages of about 40,000 characters, smaller for small context windows,
  and a reader loop of at most eight requests searches and reads pages through two reader-only
  tools before answering. Pages it reads count against the same budget as the one-request case;
  once it is used up, further pages are refused. A reader that is still reading after seven requests
  is told to answer, with its tools still declared, as providers require alongside tool calls, but
  with tool choice `none`.

The reader's system prompt treats the transcript as untrusted data, never instructions. Its answer,
like a status, is another Session's content and reaches the calling agent as untrusted tool output.
Reader requests are not recorded in the calling Session's usage, so their cost is not shown yet.
