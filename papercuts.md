# Papercuts

- 2026-08-26: Session GitHub mediation accidentally denied all non-GitHub public HTTP/HTTPS traffic.
  Repository `.agents/setup` hooks therefore could clone successfully but could not run package
  installation; Debian Snapshot requests resolved to Gondolin's synthetic deny address (`192.0.2.1`)
  and APT surfaced a misleading unsigned-repository error.
- 2026-08-26: The real GitHub mediation integration test requested 4 GiB of guest RAM and failed to
  start under a memory-constrained development orb (`Cannot allocate memory`), even though this test
  path does not require the production session memory profile.
- 2026-08-26: The first streaming Markdown typecheck failed because the committed block ID was used
  as a JSX key but was not also passed to the `MarkdownBlock` component.
- 2026-08-26: The safe-Markdown SSR test initially expected quotes in a text node to be encoded as
  `&quot;`; Remix correctly escapes the dangerous angle brackets while leaving text-node quotes
  literal.
- 2026-08-26: A targeted asset-test command omitted the repository's required `--allow-ffi`
  permission, so the native asset minifier could not load before the test ran.
- 2026-08-26: The repository-wide `deno task check` is blocked before lint and typecheck by four
  pre-existing unformatted files under `.agents/skills` that are outside this change.
- 2026-08-26: Marked's generic extension token prevents TypeScript switch narrowing; the first JSX
  renderer draft consequently violated the repository's safety-comment rule for type assertions and
  used a prohibited `catch` in URL validation.
- 2026-08-26: Deno's `no-control-regex` lint rejects intentional ASCII control-character ranges in
  URL-scheme normalization, requiring equivalent character-code filtering.
- 2026-08-26: `deno eval` parses TypeScript but not TSX, so an ad hoc JSX SSR inspection command
  failed before rendering the Markdown component.
- 2026-08-26: The first standalone browser-preview server returned an empty page because its Remix
  SSR render failed at request time; browser verification required checking the supervised service
  logs before correcting the preview harness.
- 2026-08-26: A root-level `deno eval` does not inherit the gateway package's bare `marked` import
  mapping even when given that package's config path; direct inspection needed the pinned npm URL.
- 2026-08-26: Marked represents a task-list checkbox both in list-item metadata and as a child
  token; rendering both representations produced duplicate controls until the JSX renderer used the
  token as the single source of truth.
- 2026-08-26: The scoped formatter check caught an overlong Markdown line in the task-list papercut
  added during final review.
- 2026-08-26: A portal-readiness probe guessed `/health`, but the gateway advertises `/healthz`;
  verification had to use the documented runtime endpoint.
- 2026-08-26: Submitting administrator setup through the Amp portal returned "Invalid CSRF token";
  portal verification needed to cover the public proxy origin rather than only loopback HTTP.
- 2026-08-26: The generated headless portal-login URL was forwarded to the gateway as
  `/__amp_auth/headless` instead of being consumed by the portal proxy, preventing authenticated
  browser reproduction through that helper.
- 2026-08-26: Deno 2.9 `eval` rejected explicit `--allow-*` flags because eval already runs with
  implicit permissions; the one-off provider configuration command had to omit run-style flags.
- 2026-08-26: The repository-root one-off process did not receive the gateway service's database
  configuration, so provider setup could not initialize the store outside the supervised service
  environment.
- 2026-08-26: The development runner could not start because its pinned x86-64 developer-image URL
  returned HTTP 404; portal setup requires a locally built or published matching image.
- 2026-08-26: Rebuilding the `mvp-2` x86-64 image produced different pinned metadata because Alpine
  package contents moved after the original release build, so the local output cannot safely
  substitute for the unpublished immutable asset.
- 2026-08-26: Inspecting the enrollment process with `amp orb service status` exposed its temporary
  PSK in the process arguments; the runner needed an immediate argument-free restart and enrollment
  token rotation.
- 2026-08-26: The first dogfood metadata probe called a nonexistent `listSessions` store method;
  session catalog inspection must use the repository's actual user-scoped query contract.
- 2026-08-26: Real mobile-width dogfooding showed GFM tables shrinking columns until words broke;
  the table needs a readable minimum width so its existing container scrolls horizontally.
- 2026-08-26: A table minimum width enabled internal scrolling but inherited
  `overflow-wrap:
  anywhere` still split words inside cells; table cells must restore normal word
  wrapping.
- 2026-08-26: The first scope-aware Markdown renderer check passed an explicit `undefined` through
  an optional JSX attribute helper, which is rejected by the repository's
  `exactOptionalPropertyTypes` setting.
- 2026-08-26: The first scope-aware Markdown renderer lint found that its locally mutated block
  array binding itself remains constant and must be declared with `const`.
- 2026-08-26: Two sequential Remix SSR snapshots in one test reused the first component output even
  though the pure streaming state advanced, so state transitions need pure assertions and live DOM
  reconciliation needs browser verification. The same run also found that an incomplete nested quote
  line did not yet expose the preceding stable paragraph.
- 2026-08-26: Running full Deno check, Effect diagnostics, and the complete test suite concurrently
  saturated the orb and left all three without progress; repository-wide verification must run those
  CPU-heavy commands sequentially.
- 2026-08-26: Replacing the Markdown module through a delete/add patch briefly made the gateway
  watcher restart while the module path was absent; it recovered on the next file change.
- 2026-08-26: The first progressive-heading test found that establishing the heading shell consumed
  its initial source before calculating the safe inline prefix, so safe words only appeared after a
  subsequent stream delta.
- 2026-08-26: The first recursive-list-item SSR test showed the nested fenced-code shell but not its
  first completed line because Marked's normalized list-item text drops the outer line ending; the
  current item's unconsumed partial line is needed as lookahead to preserve that inner boundary.
- 2026-08-26: A one-shot-equivalence assertion compared internal block segmentation too strictly;
  equivalent boundary blank lines can belong to either adjacent committed block without changing the
  rendered Markdown.
- 2026-08-26: Restarting the development runner terminated its active VM but exposed a stale cached
  `mvp-2` developer-image manifest whose checksum no longer matched the pinned release metadata,
  leaving the supervised runner in an auto-restart loop.
- 2026-08-26: The first fresh live Markdown dogfood session reached its new VM, but OpenCode Zen's
  Big Pickle model returned a provider-side free-usage HTTP 429 before emitting any response token.
- 2026-08-26: The gateway's provider catalog offered `opencode/deepseek-v4-flash-free`, but the
  runner's Pi `ModelRuntime` did not contain that model, so a fresh session cloned and booted before
  failing with an empty transcript.
- 2026-08-26: Deno 2.9 accepts `--env-file` for `deno eval` only after the `eval` subcommand, unlike
  options that belong to the top-level `deno` command.
- 2026-08-26: Live streaming showed that a blank line left after a fenced block could strand a GFM
  table behind the ambiguous tail until the table's closing blank line, defeating progressive rows.
- 2026-08-26: Discarding resolved top-level blank separators correctly advanced the next scope, but
  two focused state tests still expected those non-rendering separators to remain in `state.tail`.
- 2026-08-26: The repository-wide formatter also traverses ignored `.amp/in` proof artifacts, so an
  older generated JSON capture made `deno task check` report source-formatting failure during final
  live verification.
- 2026-08-26: After formatting the live artifacts, repository-wide `deno task check` still stopped
  on four pre-existing Markdown formatting violations under `.agents/skills`; final verification had
  to run formatting for the changed files and the remaining lint, type, Effect, and test checks
  separately without rewriting unrelated skill instructions.
- 2026-08-26: Effect diagnostics remained CPU-active without output for more than 20 minutes while
  the dogfood VM stayed live; the rerun had to be cancelled rather than taking down the runner the
  user asked to inspect.
- 2026-08-26: The first lint after splitting Markdown state from its JSX wrapper rejected
  `import { type Handle }` under Deno's verbatim-module-syntax rule; the wrapper needs a direct
  `import type` declaration.
- 2026-08-26: A final symbol inventory used a two-dimensional shell brace expansion that generated
  nonexistent Markdown module paths, so `rg` returned status 2 after printing the valid matches.
- 2026-08-26: Adversarial stream splits showed that list and blockquote previews moved an
  unterminated physical line across the recursive ownership frontier before its Markdown role was
  irreversible.
- 2026-08-26: The unified literal `lines` representation did not retain whether indented code or raw
  HTML ended with a newline, so completed incremental JSX could differ from one-shot Marked output.
- 2026-08-26: Assistant render identities mixed locally allocated counters with protocol message IDs
  and were not rotated when an authoritative completion replaced streamed text with a non-prefix.
- 2026-08-26: The first recursive ownership regression test compared a possibly absent current-item
  source after only an equality assertion, which does not narrow the optional value for TypeScript.
- 2026-08-26: Removing recursive partial-line previews exposed that Marked strips a list item's and
  blockquote's final physical newline from normalized child text; nested reducers need stable
  boundary-preserving normalized source for complete owned lines.
- 2026-08-26: Two first-pass regression assertions assumed a thematic break and following paragraph
  shared one committed block and initialized literal state from an already completed document;
  neither assumption is part of the renderer contract.
- 2026-08-26: Terminal code-span and strikethrough tokens in an active heading were treated as
  stable even though one more matching delimiter could make Marked reinterpret the whole token.
- 2026-08-26: Incremental fenced-code state retained indentation relative to an indented opener and
  lost an open fence's terminal content newline when end-of-response completed the scope.
- 2026-08-26: Authoritative assistant completion reused render identity when only thinking changed
  or when already-settled streamed text later received a prefix extension.
- 2026-08-26: Holding a terminal heading code span or strikethrough token could still retract the
  separator after already-rendered plain text unless the held prefix excluded trailing whitespace.
- 2026-08-26: The first indented-fence normalization removed up to the opener indentation, while
  Marked preserves shallow indentation and removes the full opener indentation only when present.
- 2026-08-26: A simplified-state test initially assigned a heading's separating newline to the
  heading token, but Marked assigns it to the following space token.
- 2026-08-26: `amp orb service start` cannot restart an ad hoc service from saved metadata alone;
  the verification service still requires its full `--command` argument.
- 2026-08-26: `amp orb service status` exits successfully when the requested service unit does not
  exist, so cleanup verification must inspect the status text or active service list.
- 2026-08-26: Marked normalizes CRLF and lone carriage returns before lexing, so summing token `raw`
  lengths produced an invalid offset into the exact canonical source.
- 2026-08-26: A reference definition arriving after a formatted reference label was committed made
  streamed and one-shot JSX disagree because only the latter produced one resolved link token.
- 2026-08-26: Task-list checkboxes were siblings of their label paragraphs while the layout grid
  targeted only the paragraph, and the boolean data attribute did not match its `="true"` selector.
- 2026-08-26: Marked's broad `MarkedOptions` annotation exposes an optional `extensions` shape that
  is incompatible with its `Marked` constructor; the shared concrete options need `satisfies`.
- 2026-08-26: The first task-layout SSR assertion through the stateful Markdown wrapper observed
  only one of two task attributes; renderer tests need an explicit pure state document.
- 2026-08-26: A safety-comment inventory used a literal newline in ripgrep's default regex mode;
  multiline patterns require `-U`, though a single-line `SAFETY:` search is sufficient here.
- 2026-08-27: Live assistant responses appeared to stream slowly, but the runner exported only
  Deno's automatic provider HTTP spans; its existing Effect spans did not have an OTLP tracer layer,
  leaving provider cadence, runner publication, gateway receipt, and SSE delivery indistinguishable.
- 2026-08-27: The first SSE instrumentation typecheck failed because the module's existing Effect
  import was type-only; adding runtime spans requires importing `Effect` as a value.
- 2026-08-27: The first runner timing instrumentation lint used an open unknown-valued attributes
  dictionary and a deferred single-assignment timestamp; repository rules require inferred closed
  span-attribute shapes and an immediate constant timestamp.
- 2026-08-27: The first dogfood link probe used agent-browser's nonexistent `get attribute`
  subcommand; this installed version uses `get attr`.
- 2026-08-27: The first gateway delta spans were created in a stream later consumed by a Remix
  controller's default Effect runtime, so they lost the gateway's configured OTLP tracer context and
  exported nothing; runner-registry streams must retain the context in which their service is built.
- 2026-08-27: Deno 2.9's `eval` subcommand rejected explicit permission flags during temporary
  browser-session cleanup because `deno eval` already runs with implicit permissions.
- 2026-08-27: The first cleanup retry used the gateway package as its working directory but tried to
  read the root `papercuts.md` without a parent-relative path, so shell short-circuiting skipped the
  cleanup script.
- 2026-08-27: A sustained high-thinking latency run emitted thousands of per-delta spans through two
  EventSource subscribers, temporarily overloading Motel's query endpoint with an empty response and
  HTTP 503; the browser probe and persisted session metadata still retained the decisive timings.
- 2026-08-27: The first in-page stutter-probe summary had one extra closing parenthesis, so its
  `agent-browser eval` failed while the independently running profiler continued capturing the live
  response.
- 2026-08-27: The orb does not include `pstree`, so inspecting a slow profiler-export process tree
  requires recursive `ps` parent-ID queries instead.
- 2026-08-27: Agent-browser reported that profiling started but its two-minute export eventually
  failed with `Tracing is not started`; the independent Long Task, animation-frame, EventSource, and
  DOM-commit probes remained available for the stutter diagnosis.
- 2026-08-27: The failed profiler export also relaunched the browser without its registered init
  script, discarding the probe's detailed interval arrays after aggregate checkpoints had already
  established the delta-to-visible-commit mismatch.
- 2026-08-27: Hiding Marked's active paragraph made a 16.5 kB live answer apply 1,226 text deltas
  but visibly update only 88 times, so normal prose arrived in paragraph-sized jumps despite an idle
  browser main thread.
- 2026-08-27: A temporary session lookup assumed `browser_sessions.project_id`, but project
  ownership lives outside that table; route verification should use the typed
  `/app/sessions/:sessionId` URL.
- 2026-08-27: Agent-browser's JSON cookie listing is an object with metadata rather than a bare
  cookie array, so piping its top-level values through an array-only `jq` projection fails.
- 2026-08-27: A second ad hoc browser-session query assumed a persisted `state` column, but session
  lifecycle state is runner-owned; temporary existence checks should select only the known `id`.
- 2026-08-27: Adding a second clause to the temporary-session papercut exceeded Deno's Markdown line
  width, so focused verification stopped at formatting before reaching lint, typecheck, or tests.
- 2026-08-27: GNU `date` accepts `--iso-8601=ns` but not `--iso-8601=milliseconds`; an unsupported
  precision made a timestamp conversion fail before the independent JSONL offset query completed.
- 2026-08-27: An Effect stream-context probe used the pre-v4 `Context.GenericTag` API; this
  codebase's Effect v4 release uses `Context.Service` for service tags.
- 2026-08-27: `Stream.provideService` scopes only the stream it wraps; a downstream `mapEffect`
  added afterward cannot see that service, so SSE tracing must be composed before the gateway
  telemetry context is provided.
- 2026-08-27: The first correlated-span patch closed a chained `pipe` with an extra brace, and a
  filtered protocol-event array did not preserve its discriminated-union narrowing for `delta`.
- 2026-08-27: `amp orb service restart` cannot restart Amp-managed portal proxy or hairpin units
  because they have neither a project declaration nor saved ad hoc metadata; the gateway restart
  preserved their healthy portal connection instead.
- 2026-08-27: The runner compile task's environment allowlist omits dependency probes such as
  `MSGPACKR_NATIVE_ACCELERATION_DISABLED` and `UNDICI_NO_FG`, so the resulting standalone binary
  exits before startup when msgpackr or Undici checks them.
- 2026-08-27: Compiling the development-runner script relocates its `import.meta.url` to Deno's
  virtual compile directory, so its relative working-directory lookup points under `/tmp`; an
  ephemeral binary needs a temporary entry with the absolute development working directory.
- 2026-08-27: A completed-Markdown SSR assertion matched the streaming cursor's generated CSS
  selector even though no cursor element was rendered; DOM-presence assertions must include the
  cursor element's `<span>` shape rather than search the full HTML for its data attribute.
- 2026-08-27: The repository-wide `deno task check` stops in formatting on four pre-existing shared
  skill documents under `.agents/skills/`; focused product-file format, lint, and type checks are
  required until those out-of-scope files are formatted by their owner.
- 2026-08-27: The first live Markdown reconciliation probe double-escaped newline fixtures, so the
  browser correctly treated them as literal `\\n` text and produced one paragraph; browser eval
  fixtures need JavaScript newline escapes after shell/JSON quoting, not another escaped layer.
- 2026-08-27: The initial durable-conversation refactor exposed two Effect/TypeScript ownership
  mismatches: the SessionManager observer option erased its required Scope, and an exact-optional
  cache field could not be cleared by assignment.
- 2026-08-27: Runner test compilation exposed stale per-run harness and durable-publication test
  fixtures, plus direct audited-factory tests that did not scope the newly cache-aware factory.
- 2026-08-27: The first targeted run showed that eagerly activating the cache in a cold-restart
  lifecycle-state fixture also eagerly captured its pre-update metadata state.
- 2026-08-27: Full static checks rejected imperative exception swallowing in the synchronous Pi
  decorator and a test helper that crossed Effect runtimes to close its cache scope.
- 2026-08-27: The Gondolin E2E task could not start because this fresh orb has no locally built
  x86_64 guest image (and no `qemu-system-aarch64` binary, which is non-blocking for x86_64 tests).
- 2026-08-27: After building the x86_64 guest image, two Gondolin environment E2Es still could not
  start their 4 GiB VMs in this memory-constrained orb (`pc.ram: Cannot allocate memory`); the
  lower-memory public GitHub mediation E2E passed.
- 2026-08-27: Replacing the browser's handwritten session-event types with the canonical Effect
  schema exposed two hidden type differences: Effect outputs are readonly, and optional fields do
  not accept an explicitly supplied `undefined` under exact optional property types.
- 2026-08-27: Gateway asset verification showed that directly decoding the canonical Effect schema
  in client code would require allowing and shipping the Effect runtime through the browser asset
  server, so the canonical wire model needs a lightweight browser validator adapter instead.
- 2026-08-27: Removing the duplicate browser validator exposed that the gateway lint policy forbids
  ad-hoc `unknown` narrowing, even for same-deployment SSE already validated by the gateway; parsing
  therefore needs an explicitly trusted owner-boundary helper rather than a partial second schema.
- 2026-08-27: The real browser/gateway/runner E2E initially inherited the orb service manager's
  `PUBLIC_URL`, so the gateway correctly rejected localhost setup submissions as an invalid CSRF
  origin until the isolated E2E service pinned its own public origin.
- 2026-08-27: A real browser/gateway/runner E2E did start exactly one 2 GiB, one-vCPU Gondolin VM,
  but the repository's full `.agents/setup` under QEMU TCG drove the 4 GiB host into sustained
  resource starvation: browser reads returned `EAGAIN` and new shell control commands stopped
  scheduling before the first Pi prompt could begin.
- 2026-08-27: A temporary E2E database helper outside the workspace could not resolve the gateway's
  bare `pg` import because it did not inherit `packages/gateway/deno.json`'s import map.
- 2026-08-27: Pinning that helper's direct `pg` import still left the imported gateway password
  module's `@openorb/result` workspace alias unresolved until Deno was given the gateway config.
- 2026-08-27: The same helper's initially narrow Deno environment permission omitted `USER`, which
  the pinned `pg` package reads while initializing its defaults even with a connection string.
- 2026-08-27: Moving conversation projection ownership into the Pi adapter exposed two callers that
  explicitly passed `undefined` to an exact-optional `create` dependency instead of omitting it.
- 2026-08-27: The aggregate repository check is blocked at `deno fmt --check` by four pre-existing
  formatting violations in `.agents/skills/domain-modeling` and `.agents/skills/grilling`.
- 2026-08-27: Recreating the real browser E2E fixture initially used `deno run` permission flags
  with `deno eval`, whose Deno 2 CLI rejects those flags before evaluating the setup helper.
- 2026-08-27: A real E2E progress query assumed runner lifecycle state was stored directly on the
  gateway `sessions` row; lifecycle state is delivered by the runner instead.
- 2026-08-27: The successful real E2E cleanup's final zero-process assertion piped `rg` into `wc`
  under `pipefail`, so the expected absence of QEMU produced a nonzero shell status.
- 2026-08-27: The OpenCode-backed E2E initially assumed restarting a runner would eagerly recreate
  the ready session VM, but no QEMU process appeared within the 90-second observation window.
- 2026-08-27: A follow-up E2E inspection also assumed the gateway `sessions` table stored a
  `runner_id`; runner assignment is not a column on that catalog row.
- 2026-08-28: The Codex patch format accepted move-only file operations syntactically but rejected
  them as no-op updates, so canonical license files fetched outside the workspace could not be moved
  into package directories without first making an actual hunk change.
- 2026-08-28: Targeted formatting found that the manually wrapped move-only-patch papercut did not
  match Deno's Markdown wrapping.
- 2026-08-26: The first ad-hoc gateway administrator password reset exited with status 1 and no
  diagnostic output, making it unclear whether environment extraction or script startup failed.
- 2026-08-26: A root-level `deno eval` could not resolve the gateway-scoped bare `pg` import, so
  one-off maintenance scripts must use an explicit npm specifier or execute in the package scope.
- 2026-08-26: Portal browser login reports an invalid CSRF origin while an equivalent direct portal
  request succeeds, and the gateway currently records no safe origin diagnostics for rejected forms.
- 2026-08-26: Effect HTTP server headers are immutable lowercase-keyed records rather than Web
  `Headers`, which makes temporary request instrumentation easy to write against the wrong API.
- 2026-08-26: The repository's `dev:otel` gateway task exports traces with an `always_off` sampler,
  so Motel instrumentation can appear healthy while recording no spans.
- 2026-08-26: `HttpServerRequest.url` may be relative even though HTTP telemetry exposes a full URL;
  constructing a `URL` from it caused temporary CSRF diagnostics to return 500.
- 2026-08-26: A fresh development runner cannot start from the configured pinned image release
  because its GitHub archive URL returns 404, requiring a local image build.
- 2026-08-26: The hardened Git report attributes used `-diff`, which tells Git every file is binary;
  real agent text edits therefore produced only “Binary files differ” instead of renderable patches.
- 2026-08-26: The isolated report repository set its synthetic `HEAD` to the session base commit, so
  a clean file committed after that base was incorrectly reported as staged.
- 2026-08-26: The supervisor test double recognized only an unwrapped `git rev-parse`, so adding the
  hardened current-HEAD lookup made report generation stop early without explaining the mismatch.
- 2026-08-26: The Changes panel grouped files as committed/uncommitted even though a working-tree
  review needs staged/unstaged groups, and its partial patches prevented Pierre's context expansion.
- 2026-08-26: Filtering an inline staged/unstaged section array widened its literal `state` values
  to `string` before assignment, despite the destination's explicit discriminated type.
- 2026-08-26: The first scripted dogfood prompt used the create-session form field `initialPrompt`
  against the follow-up endpoint, whose field is `prompt`; the 400 response did not identify the
  missing field by name.
- 2026-08-26: Dogfood retry state depended on temporary `/tmp` login artifacts that did not survive
  between agent turns, and a hand-written follow-up URL did not match the route helper's real path.
- 2026-08-26: The existing dogfood session remained visible after restarting the runner, but sending
  it a follow-up waited and returned HTTP 503 instead of reaching the agent.
- 2026-08-26: Browser dogfooding through the gateway's loopback URL could read authenticated pages
  but session creation failed CSRF origin validation because the configured app origin is the
  portal.
- 2026-08-26: An uncleared browser console retained an earlier Pierre null-line rendering error
  after the current hydrated diff rendered successfully, making stale errors look current.
- 2026-08-26: A root-level Pierre probe could not resolve the gateway-scoped `@pierre/diffs`
  dependency; package API probes must execute with the gateway package as their working directory.
- 2026-08-26: Creating a fresh dogfood session through the authenticated portal-origin form reached
  the gateway but returned HTTP 409 before provisioning a guest.
- 2026-08-26: Retrying fresh dogfood provisioning with the smaller orb size still returned the same
  generic no-capacity HTTP 409, so the response does not identify the failed capacity dimension.
- 2026-08-26: After staging the agent edit and restarting the runner, the changes endpoint continued
  serving the pre-restart cached report for over 40 seconds instead of the recovered session report.
- 2026-08-26: The repository-wide check stops at formatting because 23 skill Markdown files are not
  Deno-formatted, including the newly installed Pierre reference and pre-existing unrelated skills.
- 2026-08-26: Overlapping `sed` ranges made a partially applied Git-report patch appear to contain a
  duplicate command-tail line, requiring an extra source reread to establish the actual state.
- 2026-08-26: Focused OO-016 tests initially mixed stale split-diff command counts, RPC class/plain
  object equality, and a second snapshot after the one-shot manifest handoff, obscuring test intent.
- 2026-08-26: Starting the development runner from the updated root source rejected the previously
  verified `mvp-2` image because current release metadata no longer matched the cached manifest.
- 2026-08-26: The first 1920px dogfood screenshot showed a long Pierre diff line clipped at the
  narrow Changes-sidebar edge when the viewer used horizontal-scroll overflow.
- 2026-08-26: Pierre accepted `overflow: "wrap"` but did not apply its wrapping CSS when `FileDiff`
  rendered directly into a plain div; its core stylesheet is adopted by `diffs-container` hosts.
- 2026-08-26: `agent-browser screenshot` interpreted the documented-looking `--path` flag as an
  element selector; this installed version takes the output path as a positional argument.
- 2026-08-26: The custom Result lint requires the error tuple member to be guarded immediately,
  rejecting an intervening stale-request check even though it returned before either value was used.
- 2026-08-27: Running a focused Deno test without the repository task's environment permission
  failed during Chalk's top-level CI color detection before any test case could execute.
- 2026-08-27: Adding a live event used only for the Changes panel also widened the transcript event
  union, so its exhaustive activity reducer needed an explicit no-op case before gateway tests ran.
- 2026-08-27: The session browser test still asserted the removed `/diff` URL after the protocol and
  page contract had moved to the canonical `/git-snapshot` endpoint.
- 2026-08-27: Deno formatting compacted the two imported worker test helpers onto one line after the
  semantic Git Snapshot equality test was added.
- 2026-08-27: The first full touched-file format check found one long Gondolin assertion and one
  lifecycle documentation line that focused checks had not included.
- 2026-08-27: The Changes panel's initial cleanup flow violated the repository's immediate Result
  guards and DisposableStack-only cleanup lints even though its type-check and focused tests passed.
- 2026-08-27: Plain TypeScript accepted the coordinator tests, but Effect diagnostics required
  explicit `Effect.fn.Return` context on Deno's async test generators and an `Effect.fn`
  coordinator.
- 2026-08-27: The opt-in OO-016 Gondolin test could not start because its local developer-image
  archive was absent even though the verified unpacked image was already cached by the runner.
- 2026-08-27: The first one-off local-image metadata command used jq field shorthand instead of its
  named arguments, producing null release fields and a generic invalid-metadata failure.
- 2026-08-27: The managed development runner reads a disposable source mirror that does not follow
  root source changes, so its stale protocol v5 copy repeatedly failed against the v6 gateway with
  only the generic “runner RPC service failed” diagnostic.
- 2026-08-27: The orb does not include `rsync`, so the first attempt to synchronize the disposable
  runner source mirror stopped before copying any files.
- 2026-08-27: `agent-browser screenshot <path>` treated the only positional argument as a selector
  and generated a timestamped artifact; this version needs an explicit selector before the path.
- 2026-08-27: The final repository lint found the coordinator test's `Scope` import was used only as
  a type even though the earlier focused checks and Effect diagnostics were green.
- 2026-08-27: Running Effect diagnostics while the development runner VM and gateway were live
  exhausted the orb's memory and spent over twenty minutes swap-thrashing without output; the check
  needs the runner stopped in this small orb.
- 2026-08-27: Running the session browser tests directly without `NODE_ENV=test` bypassed the
  repository test task and failed on the missing `SESSION_SECRET` before any assertions ran.
- 2026-08-27: Motel tracing showed every stage/unstage request ran three independent read-only Git
  Snapshot commands sequentially, adding 3–3.5 seconds of guest VM round-trips after the mutation.
- 2026-08-27: The shared desktop sidebar trigger kept a fixed `left` position for the right-side
  variant, so the Changes toggle rendered over the left toggle instead of at the right edge.
- 2026-08-27: A direct Git Snapshot test invocation omitted Gondolin's required `homedir` system
  permission and failed during module initialization before running any tests.
- 2026-08-27: Stage/Unstage both received a snapshot event and requested an explicit refresh, while
  every refresh cleared the rendered file list, producing two visible loading flashes per mutation.
- 2026-08-27: The first flicker fix tried to render panel-local mutation state from the separate
  `FileSections` client component, which the targeted type-check correctly rejected as out of scope.
- 2026-08-27: A Pierre parser probe passed `--allow-read` to `deno eval`, but the installed Deno CLI
  no longer accepts runtime permission flags for `eval`; the probe must use eval's current syntax.
- 2026-08-27: Splitting exact and display Git paths made existing typed Git Snapshot fixtures fail
  compilation until each fixture explicitly supplied the newly required display path.
- 2026-08-27: A multiline ripgrep audit used negative lookahead without `--pcre2`, so ripgrep
  rejected the expression before scanning for incomplete Git Snapshot fixtures.
- 2026-08-27: The RPC-frame budget test assumed a near-full file list was within 5 KB of its cap;
  storing both exact and display paths made one maximum-size row larger than that fixed tolerance.
- 2026-08-27: Checking a disposable runner mirror from the repository root silently matched no files
  because the root Deno config excludes `.openorb-runner-dev`; checks must run inside the mirror.
- 2026-08-27: The first live Stage attempt for `literal*.txt` hit a stale `.git/index.lock`, but the
  UI exposed only a generic mutation failure and hid Git's actionable diagnostic.
- 2026-08-27: Multipart `FormData` normalized an exact Git path's LF to CRLF, so a control-character
  filename survived the snapshot and UI but no longer matched when Stage reached the runner.
- 2026-08-27: After moving unexpected Git Snapshot failures to the synchronizer, the first focused
  check found the generator's old explicit infallible return type before any tests could run.
- 2026-08-27: The focused format check surfaced an older `papercuts.md` line wrap only after this
  task appended new entries to the file, requiring the repository formatter to normalize it.
- 2026-08-27: Effect's strict diagnostics rejected test doubles that directly failed with the
  project's legacy `Data.TaggedError` classes, even though ordinary Deno checking was green.
- 2026-08-27: Simplifying the Git Snapshot synchronizer's test dependencies left two imports
  value-qualified even though they were only used as types, which the final Deno lint rejected.
- 2026-08-27: Final ownership review found the checkout-unavailable mutation branch still built an
  unused snapshot that TypeScript structurally allowed despite the narrowed public result type.
- 2026-08-27: A final disposable-mirror sync used repository-root-relative paths from inside the
  mirror, so `cp` correctly failed before changing either source tree.
- 2026-08-28: Live OO-016 dogfooding left a Stage POST pending for more than 25 seconds even though
  the supervised runner service reported active, blocking browser verification of the refresh path.
- 2026-08-28: A Git probe confirmed `git diff --no-index /dev/null <directory>` cannot synthesize
  multiple untracked-file patches; Git treats `null` as a relative peer and fails before diffing.
- 2026-08-28: A root-level Pierre parser probe could not resolve `@pierre/diffs` because the
  dependency belongs to the gateway workspace; package probes must run from `packages/gateway`.
- 2026-08-28: A control-character path probe changed into its temporary Git repository before
  invoking Deno, so package-config discovery again lost the gateway's Pierre import mapping.
- 2026-08-28: The first protocol test check after replacing flat Git Snapshot fields correctly found
  stale fixture assertions and RPC acknowledgements still reading `snapshot.files`.
- 2026-08-28: The focused runner snapshot test check likewise exposed its old aggregate summary,
  flat file, and split patch assertions before the section-owned fixtures were updated.
- 2026-08-28: A Git Snapshot test helper represented a NUL separator next to a numstat count as
  `\01`, which JavaScript parsed as a forbidden legacy octal escape before the formatter could run.
- 2026-08-28: After formatting exposed the first malformed NUL fixture, TypeScript found another
  adjacent NUL/count escape plus the remaining bounds and Gondolin assertions on the flat model.
- 2026-08-28: The cross-package fixture check found two update acknowledgement assertions outside
  the fixture blocks that still addressed the removed flat Git Snapshot file array.
- 2026-08-28: Running the protocol test directly without its normal task permissions failed during
  `msgpackr` import because it reads `MSGPACKR_NATIVE_ACCELERATION_DISABLED` from the environment.
- 2026-08-28: The focused generator test revealed metadata bounding rebuilt both sections in group
  insertion order, moving dual-state files ahead of otherwise alphabetized unstaged rows.
- 2026-08-28: Running gateway browser tests directly without `NODE_ENV=test` activated production
  session-secret validation before either test could reach the changed Git Snapshot routes.
- 2026-08-28: The first correctly configured gateway test reached one final response assertion that
  still expected the aggregate `summary.changed` field removed from the wire contract.
- 2026-08-28: A local portal-proxy dogfood attempt called agent-browser's header setting as a
  top-level command instead of the documented `set headers` form.
- 2026-08-28: The first curl-assisted local dogfood login exited silently under `set -e` before it
  could transfer the authenticated test cookie into the browser session.
- 2026-08-28: The first curl-assisted continuation attempt likewise exited before its expected 202,
  requiring step-level status output to distinguish login, page, and prompt rejection.
- 2026-08-28: Narrowing staged-section decoding to tracked rows exposed the runner's broad internal
  `SessionGitFile[]` staged type even though its generator already emitted only tracked rows there.
- 2026-08-28: The first extracted change-row check passed an explicitly undefined optional Pierre
  viewer constructor, which `exactOptionalPropertyTypes` correctly rejected.
- 2026-08-28: The acknowledgement RPC test compared an empty `Schema.Class` instance to a plain
  object, but the standard equality assertion intentionally preserves their prototype distinction.
- 2026-08-28: Extracting the browser-side changed-file module required adding it to Remix's explicit
  asset allowlist; otherwise the asset compiler rejected the new local import.
- 2026-08-28: The first focused lint of canonical diff preparation found that its Result branches
  assigned fallback state instead of returning directly, violating the repository's strict handling
  rule.
- 2026-08-28: The supervised runner service was already failed when this change reached live
  verification, so its logs had to be inspected before restarting the updated runtime mirror.
- 2026-08-28: The final combined test invocation omitted the repository test task's environment and
  runtime permissions, so six suites failed during module loading before their assertions ran.
- 2026-08-28: Replacing refresh-generation guards with direct abort checks initially put those
  checks between Result creation and its error branch, which the strict Result lint rejected.
- 2026-08-28: The atomic loaded-state refactor left one header ternary expanded beyond the
  formatter's canonical single-line form.
- 2026-08-28: Reapplying the fully staged OO-016 stash with `--index` after fast-forwarding main
  failed before changing the worktree because several upstream files changed and two paths were
  renamed or newly created; the stash must be applied without restoring its old index directly.
- 2026-08-28: Reapplying OO-016 as a renamed ticket made its inherited Markdown hard-break spaces
  appear as newly added trailing whitespace, so `git diff --check` rejected the integrated tree.
- 2026-08-28: The first post-main typecheck found OO-016 still imported the old local
  developer-image test helper/config name and exposed a restore-lifecycle conflict between
  credential-free Git updates and main's newly persistent Pi session.
- 2026-08-28: The focused formatter wrapped the post-main typecheck papercut differently from the
  hand-written line breaks.
- 2026-08-28: A Git-only worker restore followed by a failed lazy Pi open left the prompt reply
  unresolved, blocking the worker actor and every later queued command for that session.
- 2026-08-28: Moving Git updates off the actor queue exposed that cold Git restoration had relied on
  queued commands implicitly waiting for the worker's environment setup to finish.
- 2026-08-28: The session supervisor mixed worker admission and restoration with Prompt, Abort, and
  Git command dispatch plus wire-protocol response translation, obscuring its registry boundary.
- 2026-08-28: Git Snapshot boundary refreshes waited for a two-second quiet window even though the
  sliding inspection queue already serialized work and limited it to one pending refresh.
- 2026-08-28: Runner capabilities were sent during enrollment and connection identification and
  persisted by the gateway even though protocol-version admission was the only compatibility gate.
- 2026-08-28: Removing the unused runner capabilities column from its original, already-applied
  migration triggered the migration journal's checksum-drift guard.
- 2026-08-28: The simplified heartbeat test retained an unused coordinator binding, so Deno stopped
  the targeted test during type checking.
- 2026-08-28: The Git Snapshot heartbeat belonged to an individual Agent Run, so its final flush
  stopped monitoring even though the worker's Agent Environment remained alive and mutable.
- 2026-08-28: The first wake RPC test compared a decoded `SessionModelRuntime` class instance to its
  plain-object input, so strict equality correctly reported the prototype mismatch.
- 2026-08-28: Running the session browser test directly without `NODE_ENV=test` again activated
  production session-secret validation before the changed route assertions ran.
- 2026-08-28: The root task list has no standalone `lint` task; linting is part of
  `deno task check`.
- 2026-08-28: The full check found 22 pre-existing unformatted installed skill reference files, so
  repository-wide format verification cannot pass without changing unrelated content.
- 2026-08-28: `amp orb service logs` does not support the assumed `--follow` flag; the managed
  service's startup must be checked with repeated plain log reads instead.
- 2026-08-28: Both `amp orb service stop` calls hung without stopping their services, and an
  unprivileged `systemctl stop` fallback required interactive authorization.
- 2026-08-29: A Git-only restore could win admission before `session.wake`, causing the supervisor
  to return the existing credential-less worker and acknowledge wake without delivering its model
  runtime to the worker.
