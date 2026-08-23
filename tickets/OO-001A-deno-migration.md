# OO-001A — Deno-only toolchain and runtime migration

**Slice:** 0 — Runnable development baseline  
**Follow-up to:** [OO-001](OO-001-runnable-development-baseline.md)  
**Depends on:** OO-001

## Outcome

OpenOrb has one supported JavaScript/TypeScript runtime and toolchain: Deno 2.9.5. The gateway and development runner run under Deno, the repository uses Deno-native workspace/manifests/lockfile/tasks, and the Linux runner can be released as standalone x86-64 and ARM64 executables without requiring Node.js, pnpm, or an installed Deno executable on the target host.

This is a migration, not a parallel runtime path. The existing OO-001 Node.js/pnpm baseline is replaced after its behavior is reproduced under Deno.

## Scope

### Deno workspace and development commands

- Add the root Deno workspace configuration for the existing `packages/gateway`, `packages/runner`, and `packages/protocol` packages.
- Pin Deno exactly to `2.9.5` for development, CI, gateway deployment, lockfile generation, and runner compilation.
- Give each existing OpenOrb package a Deno-native `deno.json` containing its package metadata, exports, imports, and `publish: false` policy.
- Resolve dependencies through exact `npm:` and `jsr:` imports and a committed `deno.lock`; use `nodeModulesDir: "auto"` so Deno creates the local package tree required by Remix's Node-style browser-asset resolver, and keep npm compatibility dependencies only where required by the selected Remix, PostgreSQL, Gondolin, or Pi implementations.
- Remove application-runtime `package.json` files, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`. One
  private root `package.json` may declare approved local developer tooling that requires it. Deno
  must install and run that tooling. Do not use the file as an application package manifest.
- Preserve the OO-001 development workflow through the lean root task interface: `dev`, `dev:gateway`, `dev:runner`, `check`, and `test`. `check` performs formatting verification, linting, and typechecking. Production gateway startup remains package-scoped, while production runners use standalone artifacts.
- Establish Deno check, lint, format, and test commands from a clean checkout. No task or production path may invoke Node.js, npm, pnpm, or an installed Deno executable as a runtime dependency.

### Gateway

- Replace the Node-specific startup adapter with Deno-native TypeScript execution, preferably `Deno.serve()` around the existing Fetch-oriented router.
- Preserve Remix route rendering/actions, static assets, PostgreSQL access/migrations, SSE compatibility for later tickets, and signal-based graceful shutdown.
- Keep `pg` through explicit Deno npm compatibility only if compatibility testing proves it is still required; replacing the driver is outside this ticket.
- Replace the Node Argon2 password implementation with the password profile in the resolved decisions below.
- Explicitly reset the unreleased development PostgreSQL database before the migrated password implementation is used. Do not carry forward Argon2 rows or implement dual-KDF verification.

### Runner and standalone artifacts

- Replace Node-specific runner platform, process, signal, file, and system-information code with Deno APIs where practical; compatible `node:` imports are allowed only when they do not create a Node runtime requirement.
- Keep the temporary macOS development harness, without claiming macOS as a supported release target.
- Add reproducible pinned-Deno compile tasks producing:
  - `dist/openorb-runner-linux-x64`
  - `dist/openorb-runner-linux-arm64`
- Use Deno's GNU Linux targets and document/test the minimum supported glibc version. `doctor` rejects musl hosts with an actionable message.
- Use the pinned Gondolin `VM` API exclusively. OpenOrb owns typed VM options; no browser, protocol, project, model, workspace, or runner input can provide raw QEMU arguments, paths, devices, or arbitrary sandbox options.
- Compile one runner process with no `--allow-all`: filesystem access is limited to the approved runner directory, network access is unrestricted for approved public web search/fetch operation, subprocess access is limited to the architecture-appropriate QEMU suite commands proven necessary by integration tests, FFI is disabled, and environment/system permissions are narrowly scoped.
- Use the resolved runner working-directory rule: the startup CWD is the canonical runner working directory, production systemd sets `/var/lib/openorb-runner`, development uses an ignored dedicated working directory, and the MVP does not expose a configurable `--data-dir`.

### Documentation and compatibility audit

- Update `MASTER_PLAN.md`, `MVP.md`, OO-001, OO-009, OO-023, `packages/gateway/README.md`, root/package manifests, and release documentation to describe the Deno-only path, PBKDF2 profile, standalone runner, glibc baseline, and permission/QEMU boundary.
- Update the Pi/runtime scope documentation with the approved web search/fetch tool contracts and their loopback, private, link-local, cloud-metadata, redirect, and DNS-rebinding protections before implementing those tools. This ticket must not invent an unapproved Pi tool API.
- Verify that remaining `node`, `npm`, `pnpm`, `crypto.argon2`, `@types/node`, and `NodeJS` references are either documented Deno compatibility details or removed; references implying a required Node.js/pnpm installation are not acceptable.

## Ticket-specific acceptance interfaces

The following interfaces are fixed for this follow-up:

1. A clean checkout uses Deno 2.9.5 and the documented root commands:
   ```sh
   deno task dev
   deno task dev:gateway
   deno task dev:runner
   deno task check
   deno task test
   deno task compile:runner:linux-x64
   deno task compile:runner:linux-arm64
   deno task release:runner
   ```
2. The gateway health endpoint and browser shell remain available at the OO-001 interfaces (`/healthz` and `http://localhost:44100`) when started through Deno.
3. The compiled runner artifact names and target architectures are exactly `openorb-runner-linux-x64` for `x86_64-unknown-linux-gnu` and `openorb-runner-linux-arm64` for `aarch64-unknown-linux-gnu`.
4. The compiled runner starts from its canonical runner working directory and does not accept a configurable `--data-dir` in the MVP.
5. QEMU is launched only through the pinned Gondolin `VM` integration. There is no OpenOrb raw-QEMU command or arbitrary-argv interface.
6. The runner's public network permission is not used as the SSRF boundary: application/Gondolin egress policy continues to deny loopback, private, link-local, cloud-metadata, redirect, and DNS-rebinding destinations.

## Acceptance criteria

- A clean checkout can install/resolve dependencies with the pinned Deno workflow and pass `deno check`, `deno lint`, format checking, and `deno test` without Node.js or pnpm.
- No application-runtime `package.json`, `pnpm-workspace.yaml`, or `pnpm-lock.yaml` remains tracked.
  The private root `package.json` contains only approved local developer tooling. The Deno workspace
  and lockfile remain authoritative for application runtime dependencies.
- The gateway, `/healthz`, PostgreSQL migrations, and existing authentication/session tests run under Deno.
- Password credentials use only PBKDF2-HMAC-SHA-256 with 600,000 iterations, a random 16-byte salt, and a 256-bit derived key. Wrong passwords, malformed metadata, and length mismatches fail safely. No Argon2 compatibility path exists.
- The temporary runner harness starts under Deno and reports actionable prerequisite errors without requiring a VM in the baseline tests.
- Both standalone Linux runner artifacts compile reproducibly with Deno 2.9.5, report the correct architecture/version, and start on supported glibc Linux hosts that have neither Node.js nor an installed Deno executable.
- Runner permission tests demonstrate that production execution does not use `--allow-all`, cannot use FFI, cannot access outside the runner directory, and cannot spawn commands outside the approved QEMU suite. Malicious protocol/workspace input cannot alter Gondolin's typed VM options or cause arbitrary host-file/device access through QEMU.
- Host-Git prohibition, Gondolin-backed tools, and the explicit empty Pi resource-loader/in-memory-settings boundaries remain intact after the runtime migration.
- CI/release documentation contains the Deno 2.9.5 pin, clean-room commands, artifact targets/checksums, no-Node/no-Deno smoke test, glibc-only MVP host baseline, and runner permission model.

## Tests

- Clean-room Deno install/lockfile, combined `deno task check`, and test run with no pnpm invocation.
- Gateway health/rendering, PostgreSQL migration, session persistence, and graceful-shutdown smoke tests under Deno.
- PBKDF2 correct/incorrect password, malformed profile, equal-length/timing-safe comparison, and rate-limit regression tests.
- Deno runner prerequisite and platform tests, including working-directory and denied-permission behavior.
- Standalone x86-64/ARM64 artifact smoke tests on native glibc Linux hosts without Node.js or Deno installed.
- QEMU/Gondolin typed-launch tests, including rejection of arbitrary subprocesses, paths, devices, and arguments.
- Existing security tests proving no native host Git consumes a session workspace and Pi does not discover hostile workspace resources.
- Documentation/reference audit for required/forbidden Node.js and pnpm references.

## Not included

- New product features, session protocol changes, or parallel Node.js/Deno execution paths.
- Changing the PostgreSQL driver, Remix version, Gondolin version, Pi version, or VM architecture unless a compatibility blocker is isolated and separately approved.
- Generic QEMU launching, user-selectable VM arguments/devices, or a supervisor/Worker permission split.
- Embedding VM images in runner executables, musl Linux support, macOS release runners, or automatic migration of legacy production data.
- Argon2 compatibility, dual-KDF verification, or silent deletion of development data.
- Secret-storage persistence and AES-GCM helpers; implement and test the already-approved encryption design with the credential-storage tickets that first use it.
- Guest-image metadata, acquisition, integrity verification, and Gondolin integration; implement them in OO-009 with real image assets.
- Pi project resource discovery, project extensions/settings/packages/skills/prompts/themes, or an unapproved web-tool contract.
- Browser terminal, previews, binary runner transport, checkpoints, durable prompt queues, or other deferred MVP features.
