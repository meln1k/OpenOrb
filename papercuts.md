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
