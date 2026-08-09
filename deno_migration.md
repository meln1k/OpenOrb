# OpenOrb Deno Migration Plan

> Handoff document for migrating OpenOrb from Node.js/pnpm to Deno as the only JavaScript/TypeScript runtime and toolchain.
>
> This document records the migration direction agreed in the design discussion. `MVP.md` still overrides `MASTER_PLAN.md` for product scope. Update both documents and the applicable ticket before changing implementation code.

## 1. Goal

Use Deno for the entire OpenOrb TypeScript codebase:

- Deno is the only required JavaScript/TypeScript runtime.
- Remove the Node.js and pnpm installation requirements.
- Use Deno workspaces, dependency resolution, lockfile, tasks, checking, formatting, linting, and tests.
- Run the control panel on Deno.
- Package the Linux runner as a standalone executable with `deno compile`, so a runner host needs only the OpenOrb executable, QEMU/KVM, and the required guest assets.
- Preserve all security boundaries in `MVP.md`, especially Gondolin-only agent tool execution, no host Git against a workspace, and no Pi workspace resource discovery.

Using npm packages or Deno's `node:` compatibility APIs under the Deno runtime is allowed when Deno or the Deno standard library has no equivalent. This does not permit a Node.js runtime dependency on target hosts.

## 2. Decisions already made

1. **One runtime:** use Deno everywhere; do not maintain parallel Node and Deno execution paths.
   - Pin Deno exactly to **2.9.5** for development, CI, control-panel deployment, lockfile generation, and runner compilation.
   - Deno upgrades are intentional compatibility changes that rebuild both runner artifacts.
2. **Standalone runner:** release Linux x86-64 and ARM64 runner executables produced by `deno compile`.
3. **Password KDF:** replace Node 24.7 `crypto.argon2()` with Deno's documented Web Crypto password-hashing recipe: PBKDF2-HMAC-SHA-256, 600,000 iterations, a random 16-byte salt, and a 256-bit derived key.
4. **No native password package:** use the Web Crypto API built into Deno; do not add a native npm password-hashing dependency or require a `node:` crypto compatibility import for password hashing.
5. **Control secret encryption:** use `@std/crypto`'s `encryptAesGcm()` and `decryptAesGcm()` directly, persist their returned bytes unchanged as an opaque payload, and store the key version separately while authenticating required immutable metadata as AAD.
6. **Least privilege:** the runner must not run with `--allow-all`. Its filesystem, subprocess, environment, FFI, and system-information permissions remain restricted. Network permission is intentionally not hostname-allowlisted because Pi must expose web search/fetch capabilities that reach arbitrary public hosts; existing policy blocking loopback, private/link-local networks, and cloud metadata remains mandatory.
7. **External runtime dependency:** QEMU/KVM remains an external host prerequisite; Node.js and Deno do not.
8. **Deno-native manifests:** remove project `package.json` files and express workspace packages, tasks, imports, exports, and dependency versions through `deno.json` files. npm packages remain usable through explicit `npm:` specifiers; using an npm dependency does not require an OpenOrb `package.json`.
9. **Pi web access:** expose approved web search/fetch tooling to the Pi agent. Update `MVP.md` and the applicable Pi/runtime ticket to define the exact tools and preserve SSRF/internal-network protections.
10. **QEMU launch ownership:** use the pinned Gondolin `VM` API exclusively. OpenOrb constructs trusted typed VM options and exposes no raw QEMU executable/argument interface. Deno permits only the exact QEMU-suite commands proven necessary by the MVP integration path.

## 3. Required project-process step

Before implementation, follow `AGENTS.md`:

1. Read `MASTER_PLAN.md` completely.
2. Read `MVP.md` completely.
3. Read `tickets/README.md` completely.
4. Read the complete migration ticket.

The dedicated Deno migration follow-up is `tickets/OO-001A-deno-migration.md`, approved as a follow-up to OO-001. Copy the resolved decisions in section 12 into that ticket and use its ticket-specific acceptance interfaces rather than allowing implementation to invent them. Do not begin implementation work outside that ticket's scope.

## 4. Deno API findings

### 4.1 Standalone executables

`deno compile`:

- Embeds `denort`, the application module graph, and resolved dependencies.
- Produces an executable that does not require Deno or Node.js on the target host.
- Bakes runtime permission flags into the executable.
- Supports cross-compilation for the required release architectures:
  - `x86_64-unknown-linux-gnu`
  - `aarch64-unknown-linux-gnu`
- Can embed additional modules and data with `--include` and `--include-as-is`.
- Includes statically analyzable dynamic imports automatically; computed imports and some worker patterns require explicit inclusion.
- Embeds the resolved npm tree by default. Experimental `--bundle` can reduce size but has dynamic import/require limitations.

The official Linux compile targets are GNU targets. There is no documented official musl target. Unless a separate supported approach is proven, the release host baseline must be glibc Linux.

### 4.2 Cryptography

`@std/crypto` provides:

- `encryptAesGcm()`
- `decryptAesGcm()`
- `timingSafeEqual()`
- Additional digest algorithms layered over Web Crypto

`encryptAesGcm()` generates a random 96-bit nonce and returns:

```text
12-byte nonce || ciphertext || 16-byte authentication tag
```

The global Web Crypto API provides AES-GCM, HMAC, PBKDF2, key import/export, digests, and secure randomness through `crypto.getRandomValues()`.

For password hashing, follow Deno's documented recipe:

- PBKDF2-HMAC-SHA-256
- 600,000 iterations
- random 16-byte salt
- 256-bit derived key
- comparison with `@std/crypto/timing-safe-equal`

This is fully available through Web Crypto and the Deno standard library, with no native dependency or `node:` compatibility import. `@std/crypto/timing-safe-equal` documents that it is a best-effort JavaScript implementation without formal V8 constant-time guarantees; retain this caveat in the security review while following Deno's published password-hashing example.

### 4.3 npm compatibility without npm manifests

Deno can resolve npm packages directly from `deno.json` imports using explicit `npm:` specifiers. Existing dependencies such as Remix, `pg`, Gondolin, and Pi may therefore remain npm dependencies without retaining OpenOrb `package.json` files or requiring npm/Node tooling.

OpenOrb workspace packages should use Deno-native `name`, `version`, `exports`, `imports`, and `publish: false` metadata. The root Deno workspace should own shared exact versions and configuration. Internal packages should resolve through Deno workspace membership and exports rather than npm workspace metadata.

Deno does not directly use `pnpm-workspace.yaml` as workspace configuration. Move all workspace definitions into the root `deno.json`; do not auto-migrate them into `package.json`.

npm lifecycle scripts do not run by default. Any required scripts must be explicitly approved. The current pnpm configuration permits builds for `cpu-features`, `esbuild`, and `ssh2`, but those approvals must not be copied blindly. In particular, `esbuild` is currently only a transitive dependency through Remix's test/CLI packages; Deno already transpiles server-side TypeScript directly, so do not approve or add the npm `esbuild` package unless the selected browser-asset build path demonstrably requires it.

## 5. Target repository/tooling shape

Create a root `deno.json` as the authoritative workspace configuration. The final exact file is part of implementation, but it should cover:

- Workspace members under `packages/*`
- Exact dependency versions/catalogs
- Shared compiler options
- Root and recursive tasks
- Formatting and linting policy
- Test configuration
- Compile configuration and explicitly embedded runner assets
- Explicit npm lifecycle-script approvals, if any remain necessary

Replace:

- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- pnpm-recursive scripts
- npm TypeScript compiler usage where `deno check` is sufficient
- Node test commands

With:

- `deno.json`
- `deno.lock`
- `deno task`
- `deno install --frozen` or `deno ci` in CI
- `deno check`
- `deno test`
- `deno fmt`
- `deno lint`

The target repository contains no OpenOrb `package.json` files. Give each workspace member a Deno-native `deno.json` with its package name, exports, imports, and `publish: false` policy. Use explicit `npm:` imports for npm dependencies and `jsr:` imports for JSR dependencies.

Remove manifests incrementally while proving the pinned Remix, Gondolin, Pi, and `pg` dependency graphs. If a dependency or framework tool incorrectly requires an application `package.json`, treat that as a compatibility blocker to isolate or fix—not as the default long-term configuration.

## 6. Control-panel migration

### 6.1 Server runtime

Replace the Node-specific startup path:

```text
node --import remix/node-tsx server.ts
```

The target should use Deno-native TypeScript execution and preferably `Deno.serve()` around the existing Fetch-oriented router. Remove `remix/node-tsx` and the Node-specific normal HTTP adapter if Remix's Fetch router works directly.

Required validation:

- Normal Remix routes and actions
- Server rendering
- Static assets
- PostgreSQL connections and migrations
- SSE when later tickets add it
- Signal-based graceful shutdown
- Production startup under noninteractive permission enforcement

`pg` may remain through Deno npm compatibility initially. Replacing the database driver is not part of this migration unless compatibility testing proves it necessary; changing it would require a separate persistence-interface decision.

### 6.2 Password hashing

Replace `packages/control/app/data/password.ts` Argon2 logic with Deno's documented asynchronous Web Crypto PBKDF2 recipe.

Target persisted metadata:

```ts
interface PasswordHash {
  algorithm: "PBKDF2";
  hash: "SHA-256";
  iterations: 600_000;
  salt: Uint8Array;
  derivedKey: Uint8Array;
  keyLengthBits: 256;
}
```

Requirements:

- Unique cryptographically random 16-byte salt per credential
- Asynchronous `crypto.subtle.deriveBits()`
- Exactly 600,000 PBKDF2-HMAC-SHA-256 iterations
- 256-bit derived key
- Equal-length check followed by `@std/crypto/timing-safe-equal`
- Accept only the recognized versioned password-hash profile rather than arbitrary database-provided work factors
- Unit tests for correct password, incorrect password, malformed metadata, and length mismatch
- Login rate limiting remains mandatory

The migration requires an explicit reset of the unreleased development PostgreSQL database. Do not carry forward Argon2 credentials, users, sessions, or any other legacy development data, and do not implement dual-KDF verification. The reset must be documented and intentional rather than silently deleting a database during normal startup. After reset, run first-time administrator setup to create the PBKDF2 credential.

### 6.3 Secret encryption

Keep the master-key and envelope-encryption requirements from the plans.

Use:

- `crypto.subtle.importKey()` for the 256-bit master key
- `@std/crypto/aes-gcm` for encryption and decryption
- Authenticated immutable metadata as additional authenticated data
- An explicit key-version field stored separately

Treat the `Uint8Array` returned by `encryptAesGcm()` as an opaque payload and persist it unchanged in PostgreSQL. Do not manually generate, split, or reassemble its nonce/ciphertext/tag format. Pass the unchanged payload to `decryptAesGcm()`, which parses and authenticates it. OpenOrb remains responsible only for loading the deployment master key, selecting the key version, constructing the approved stable AAD, and storing the opaque bytes.

## 7. Runner migration and standalone packaging

### 7.1 Runtime APIs

Replace Node-specific runner code with Deno APIs where practical:

- Process arguments and environment
- Platform and architecture reporting
- Signal handling
- Files and atomic persistence
- Subprocess execution
- System information

A `node:` compatibility import is acceptable where Deno intentionally provides the required API and replacing it adds risk without reducing runtime requirements. There must still be no Node executable requirement.

Change runner prerequisite/version reporting from Node-version checks to:

- OpenOrb runner version
- Deno/denort version
- Protocol version
- Gondolin version
- Pi version
- QEMU executable/version
- Supported guest image/build IDs when implemented

### 7.2 Compile artifacts

Produce at least:

```text
dist/openorb-runner-linux-x64
dist/openorb-runner-linux-arm64
```

Conceptual targets:

```sh
deno compile --target x86_64-unknown-linux-gnu ...
deno compile --target aarch64-unknown-linux-gnu ...
```

The exact permissions, includes, entrypoint, and output names must come from the approved migration ticket.

Release requirements:

- Reproducible pinned Deno version
- Frozen `deno.lock`
- Both artifacts built in CI
- SHA-256 checksums
- Signed release/checksum manifest when the release ticket reaches that scope
- Smoke test on native Linux x86-64 and ARM64 where available
- Verify startup on a machine with no `node` and no `deno` executable installed
- Verify failure is actionable when QEMU/KVM is unavailable

### 7.3 Guest and Gondolin assets

Deno can embed data files, but QEMU cannot read Deno's in-memory virtual filesystem directly. Any kernel, initrd, disk image, firmware, or helper that QEMU consumes must exist as a real host file.

Choose one approved strategy:

1. Embed immutable assets with `--include-as-is`, then atomically extract them into the runner directory and verify hashes before use; or
2. Download versioned signed assets into the runner directory and verify hashes before use.

Do not use self-extracting mode by default without reviewing its documented tamper and disk trade-offs. Do not silently trust previously extracted mutable files.

### 7.4 Dependency graph

Prove that compiled release binaries do not depend on host Node or incompatible native addons.

Review at least:

- Gondolin's QEMU backend and dynamic imports
- Pi's resource/module loading
- `ssh2`
- optional `cpu-features` native addon
- Gondolin's optional platform runner packages
- any esbuild lifecycle/native artifacts used only during development

Prefer a QEMU-only reachable module graph for the MVP runner. Do not rely on cross-compiled host-native `.node` binaries. If a native addon is unavoidable, its target-specific build and extraction behavior must be explicit and tested.

Start with normal `deno compile`, not experimental `--bundle`. Consider `--exclude-unused-npm` or bundling only after the reliable executable works and all dynamic loading is covered by tests.

## 8. Runner permission model

### 8.1 Required principle

The standalone runner must fail closed when code attempts to:

- Read or write outside its approved runner directory
- Spawn an executable other than the approved QEMU command
- Read undeclared environment variables or system information
- Use FFI

No production command may use `--allow-all`.

### 8.2 Network permission

The runner intentionally receives unrestricted Deno network permission because Pi exposes web search/fetch tooling that must reach arbitrary public hosts. Do not maintain a hostname allowlist in Deno permissions.

Unrestricted public web access does not permit SSRF into the runner host or its network. Preserve application/Gondolin egress enforcement that blocks loopback, private, link-local, and cloud-metadata destinations, including redirects and DNS-rebinding cases. Deno network permission is not the internal-network security boundary.

### 8.3 Resolved direct permission model

Because network access is intentionally unrestricted, deployment-specific network permissions do not justify a supervisor/Worker split. Use one compiled runner process with baked permissions for:

- read/write only the approved runner directory
- unrestricted network access
- execution of only the architecture-appropriate QEMU executable
- no FFI
- only explicitly required environment variables and system information

This avoids depending on Deno's unstable per-Worker permission API. QEMU argument construction must remain OpenOrb-owned and constrained, and the Linux systemd sandbox must restrict the QEMU child at the OS level.

### 8.4 QEMU is outside the Deno sandbox

Deno permissions restrict whether the runner can launch a process; they do not sandbox the child. Deno's documentation warns that `allow-run` can effectively permit arbitrary host execution, and QEMU accepts powerful arguments.

Therefore:

- Never expose a generic QEMU argv interface to Pi, project content, Gondolin guest input, or runner protocol input.
- Use a constrained launcher/configuration builder.
- Keep all untrusted commands inside Gondolin.
- Add systemd hardening in the Linux service ticket, including narrowly selected `ProtectSystem`, `ReadWritePaths`, `NoNewPrivileges`, device access, and related controls compatible with KVM/QEMU.
- Test that malicious runner-protocol and workspace input cannot cause QEMU to open arbitrary host files or devices.

## 9. Documentation and ticket updates

At minimum, update references in:

- `MASTER_PLAN.md`
- `MVP.md`
- `tickets/OO-001-runnable-development-baseline.md`
- `tickets/OO-002-admin-setup-and-login.md`
- `tickets/OO-009-minimal-developer-image.md`
- `tickets/OO-023-linux-runner-service.md`
- `packages/control/README.md`
- Root/package manifests and CI documentation

Required documentation changes include:

- Deno-only monorepo/toolchain
- Deno control runtime
- Deno-documented Web Crypto PBKDF2 password storage instead of Node Argon2
- standalone compiled runner distribution
- no Node installation prerequisite
- glibc host baseline unless musl support is separately proven
- permission model and QEMU child-process boundary
- Deno/runner compatibility reporting

Search for all remaining references before completing the migration:

```sh
rg -i '\bnode(\.js)?\b|\bpnpm\b|crypto\.argon2|@types/node|NodeJS\.'
```

Not every `node:` import must disappear: documented Deno compatibility APIs may remain. Every reference implying a required Node runtime or pnpm installation must disappear.

## 10. Suggested implementation sequence

### Phase 0 — Approve scope and update decisions

- Create/approve the migration ticket. **Complete:** `OO-001A` is the dedicated follow-up to OO-001.
- Update `MVP.md` and `MASTER_PLAN.md` technology decisions.
- Lock the minimum Deno version.
- Copy the resolved section 12 decisions into the migration ticket and acceptance criteria.

**Exit:** Documentation and ticket acceptance criteria describe one Deno runtime and standalone runner artifacts.

### Phase 1 — Deno workspace baseline

- Add root Deno configuration and lockfile.
- Re-express exact dependencies and workspace members.
- Replace root/package scripts with Deno tasks.
- Convert tests to run under `deno test`; keeping portable `node:test` imports temporarily is acceptable if Deno runs them reliably.
- Establish `deno check`, format, lint, and CI.
- Remove pnpm only after clean install/test succeeds from an empty dependency/cache state.

**Exit:** Control, protocol, and development runner tests pass with Deno commands and no pnpm invocation.

### Phase 2 — Control runtime and crypto

- Reset the unreleased development PostgreSQL database, then replace Argon2 with PBKDF2-HMAC-SHA-256; carry no legacy data or dual-KDF path.
- Replace Node startup adapter with Deno startup.
- Prove Remix routes, PostgreSQL sessions, CSRF/auth, migrations, and graceful shutdown.
- Use Deno/Web Crypto primitives for new encrypted-secret work.

**Exit:** Control tests pass under Deno and login survives a control restart against PostgreSQL.

### Phase 3 — Runner runtime compatibility

- Convert prerequisite/platform/process code to Deno.
- Run Gondolin and Pi compatibility spikes under Deno.
- Audit dynamic imports, optional native dependencies, and runtime filesystem assumptions.
- Implement the approved runner permission architecture.

**Exit:** Development runner starts under Deno with no Node process and denied operations fail as expected.

### Phase 4 — Standalone runner

- Add target-specific compile tasks.
- Include or provision required guest assets.
- Produce both Linux artifacts.
- Test on hosts with no Node or Deno installation.
- Add artifact checksums and version output.

**Exit:** Both standalone binaries launch QEMU through the constrained path and pass runner smoke/security tests.

### Phase 5 — Remove legacy tooling

- Delete pnpm lock/workspace files and obsolete TS/Node tooling.
- Remove stale Node runtime checks and docs.
- Run clean-room CI from only Deno plus required OS tools.
- Confirm no production path executes `node`, `npm`, `pnpm`, or an installed `deno` binary.

**Exit:** The repository and release documentation have a single supported Deno path.

## 11. Acceptance and security tests

Add tests proving:

### Toolchain

- `deno install --frozen` or `deno ci` succeeds from a clean checkout.
- `deno check`, `deno lint`, format check, and `deno test` pass.
- No script invokes Node or pnpm.

### Control

- PBKDF2-HMAC-SHA-256 hashes and verifies valid passwords using the resolved Deno-documented profile.
- Wrong passwords and malformed persisted metadata fail safely.
- Password derivation is asynchronous and rate-limited at the endpoint.
- AES-GCM rejects modified ciphertext, tag, nonce, key version, or authenticated metadata.
- PostgreSQL sessions survive process restart.

### Runner executable

- Linux x86-64 and ARM64 binaries run without Node or Deno installed.
- The executable cannot read/write outside the runner directory.
- The main runner cannot spawn arbitrary commands.
- Pi web search/fetch can reach arbitrary public hosts, while loopback, private, link-local, and cloud-metadata destinations are denied by tested application/Gondolin egress policy.
- QEMU receives only constructed and validated arguments.
- Embedded/extracted assets are hash-verified and tampering is detected.
- Missing QEMU/KVM produces an actionable doctor/startup error.
- Gondolin-backed tools still cannot access the runner host.
- Host Git remains forbidden against guest-writable workspaces.
- Pi still uses the explicit empty resource loader and in-memory settings.

### Release

- Artifact target and architecture reporting are correct.
- Checksums match downloaded artifacts.
- A clean supported Linux host can enroll using only the executable, control-panel URL, enrollment PSK, and QEMU/KVM prerequisites.

## 12. Resolved migration decisions

The user explicitly approved all decisions below. Preserve them in the migration ticket and implementation:

1. **Minimum Deno version — RESOLVED:** pin Deno exactly to **2.9.5** for development, CI, control-panel deployment, lockfile generation, and runner compilation. Do not use a loose minimum-version range during the MVP.
2. **Password-hashing profile — RESOLVED:** use PBKDF2-HMAC-SHA-256 through Web Crypto with exactly 600,000 iterations, a random 16-byte salt, and a 256-bit derived key, following Deno's documented password-hashing example.
3. **Existing Argon2 development rows — RESOLVED:** explicitly reset the unreleased development PostgreSQL database and recreate the administrator. Carry no legacy users, credentials, browser sessions, or other development data, and implement no Argon2 compatibility or dual-KDF path.
4. **Secret ciphertext format — RESOLVED:** use `@std/crypto`'s `encryptAesGcm()` and `decryptAesGcm()` directly. Persist the returned encrypted bytes unchanged as one opaque PostgreSQL value, store key version separately, and authenticate the required immutable metadata as AAD. Do not manually parse or construct nonce/ciphertext/tag fields.
5. **Permission architecture — RESOLVED:** use one compiled runner process with runner-directory read/write scope, unrestricted network permission for arbitrary public web search/fetch, QEMU-suite-only subprocess permission, no FFI, and narrowly scoped environment/system access. Do not use a supervisor/Worker split. Preserve application/Gondolin blocking of loopback, private, link-local, and cloud-metadata destinations.
6. **QEMU launch interface — RESOLVED:** do not create an OpenOrb raw-QEMU interface. Use the pinned Gondolin `VM` API exclusively with OpenOrb-owned trusted typed options. Browser, protocol, project, and model input cannot select QEMU paths, arguments, devices, or arbitrary sandbox options. Permit only the architecture-specific `qemu-system-*` command and `qemu-img` if integration tests prove it necessary; fail tests on any other host subprocess.
7. **Runner working directory — RESOLVED:** the startup CWD is the runner data root and the compiled filesystem permissions are relative to it. Production systemd sets `WorkingDirectory=/var/lib/openorb-runner` under a dedicated service user; development uses a dedicated ignored data directory, never the repository root. Do not support a configurable `--data-dir` in the MVP. Canonicalize the CWD, reject a symlinked root, and retain explicit workspace traversal/symlink protections.
8. **Guest asset distribution — RESOLVED:** distribute architecture-specific guest assets separately from the runner executable. Pin an exact image build ID and trusted hashes in runner release metadata; download atomically into `images/<build-id>/`, verify before use, and pass only verified real filesystem paths to Gondolin/QEMU. Never resolve `latest` in production and do not embed the VM image with `deno compile`.
9. **Host libc support — RESOLVED:** support glibc Linux x86-64 and ARM64 runner hosts only for the MVP, matching Deno's official `*-unknown-linux-gnu` compile targets. `doctor` must reject musl with an actionable message. Alpine remains allowed as the Gondolin guest; custom denort musl builds and unverified compatibility layers are deferred. Determine and test the exact minimum glibc version from final artifacts before OO-023 completes.
10. **Manifest-removal compatibility — RESOLVED:** enforce a fully Deno-native tracked repository. Root and package `deno.json` files own configuration; use exact `npm:`/`jsr:` imports, `deno.lock`, and `nodeModulesDir: "none"` unless proven impossible. Dependency-owned npm metadata in Deno's cache/compiled graph is allowed, but OpenOrb-owned `package.json`, pnpm workspace, and pnpm lock files are forbidden. Treat any dependency requirement for an application `package.json` as a compatibility blocker to isolate or patch, not a reason to retain a shim manifest.

Do not change these decisions silently while editing code; a change requires explicit user approval and corresponding plan/ticket updates.

## 13. Known risks

- The pinned Remix 3 beta may rely on Node-specific behavior despite Deno npm compatibility.
- Gondolin and Pi declare/support Node-oriented execution today; compatibility must be proven rather than inferred from engine checks.
- Deno reports a synthetic compatible Node version to npm packages, so an `engines.node` check passing is not evidence of complete runtime compatibility.
- Dynamic imports, workers, package metadata reads, and native addons can be missed during standalone compilation.
- Optional native dependencies can make cross-compilation host-dependent.
- Broad compile-time permissions can undermine the intended runner confinement.
- QEMU is not confined by Deno permissions after launch.
- Embedded QEMU-consumed assets require extraction to real files and integrity verification.
- Deno's built-in TypeScript version and diagnostics may differ from the currently pinned npm TypeScript version.
- Official Deno standalone Linux targets are GNU, potentially excluding musl-only hosts.

## 14. Source references

- Deno compile: <https://docs.deno.com/runtime/reference/cli/compile/>
- Deno Node/npm compatibility: <https://docs.deno.com/runtime/fundamentals/node/>
- Deno workspaces: <https://docs.deno.com/runtime/fundamentals/workspaces/>
- Migrating from pnpm: <https://docs.deno.com/runtime/migrate/migrate_from_pnpm/>
- Deno permissions: <https://docs.deno.com/runtime/reference/permissions/>
- Deno Permissions API: <https://docs.deno.com/api/deno/~/Deno.permissions>
- Deno `node:crypto`: <https://docs.deno.com/api/node/crypto/>
- Deno standard crypto overview: <https://docs.deno.com/runtime/reference/std/crypto/>
- `@std/crypto` API: <https://jsr.io/@std/crypto/doc>
- `encryptAesGcm`: <https://jsr.io/@std/crypto/doc/~/encryptAesGcm>
- `decryptAesGcm`: <https://jsr.io/@std/crypto/doc/~/decryptAesGcm>
- `timingSafeEqual`: <https://jsr.io/@std/crypto/doc/~/timingSafeEqual>
- Deno password-hashing example: <https://docs.deno.com/examples/hash_password/>

## 15. Handoff status

- Research completed against current Deno documentation.
- `tickets/OO-001A-deno-migration.md` is the approved dedicated follow-up to OO-001.
- Password hashing is resolved to Deno's documented Web Crypto PBKDF2 recipe; implementation has not started.
- No implementation migration has started.
- The next implementation session should begin with OO-001A's workspace/toolchain phase, after reviewing its complete acceptance criteria.
