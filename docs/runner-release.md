# Runner release process

OO-001A establishes the standalone runner build path. OO-009 supplies the first real guest-image
build metadata and OO-023 completes supported-host/service validation.

## Pinned toolchain

Use Deno 2.9.5 exactly with a frozen `deno.lock`. Dependency installation creates a Deno-managed
local `node_modules` tree for gateway browser-asset compatibility; it is only a build/development
input and is not shipped with the standalone runner:

```sh
deno --version
deno install --frozen
deno task check
deno task test
deno task release:runner
```

No command invokes Node.js, npm, or pnpm. The compile tasks use Deno's managed npm graph and local
links, not experimental bundling and not npm lifecycle scripts.

### Deno/Gondolin TLS compatibility gate

Guest HTTPS egress, including GitHub mediation and on-demand browser downloads, depends on Gondolin
0.12.0 terminating TLS over its custom `GuestTlsStream`. Gondolin constructs a server `node:tls`
`TLSSocket` and asynchronously supplies the per-host `SecureContext` through `SNICallback`. Node
resumes the paused handshake after the callback. In the reduced OpenOrb reproduction, Deno 2.9.5
left that custom-`Duplex` handshake paused, so the decrypted request never reached Gondolin's HTTP
stack until `TLSSocket._start()` was called.

`packages/runner/src/environment/gondolin/tls-compatibility.ts` contains the narrowly scoped
workaround. It replaces `tls.TLSSocket` once, immediately before the first Gondolin VM starts, and
calls the private `_start()` method only after a successful asynchronous SNI callback. It does not
disable certificate validation or broaden the HTTP allowlist. The replacement is process-wide after
it is installed, relies on a private Deno API, and is validated only for Deno 2.9.5 with Gondolin
0.12.0.

There is no Deno flag that supplies the missing handshake continuation. `--cert` changes trusted
certificate authorities, while `--unsafely-ignore-certificate-errors` weakens outbound certificate
validation; neither is a substitute. Related Deno fixes cover the initial server-side TLS start
([#33303](https://github.com/denoland/deno/pull/33303)), SNI callbacks
([#33360](https://github.com/denoland/deno/pull/33360)), and custom-`Duplex` TLS write cycles
([#33914](https://github.com/denoland/deno/pull/33914)), but not the reproduced asynchronous-SNI
stall.

The unit test `Gondolin TLS compatibility requires review when Deno or Gondolin changes` ties the
workaround to both dependency pins. The runtime also rejects an unreviewed Deno version before
installing the shim. When upgrading Deno or Gondolin:

1. Expect the version-gate test to fail; do not update its validated versions mechanically.
2. On the target versions, temporarily bypass the `installGondolinTlsCompatibility()` call in
   `packages/runner/src/environment/gondolin/layer.ts` (never commit that bypass) and run
   `deno task test:gondolin`. The public GitHub clone is the checked-in async-SNI/custom-`Duplex`
   regression path: if it stalls before the HTTP hook, native Deno behavior still needs a
   compatibility fix.
3. If native TLS now completes, delete the workaround and its version gate, then run the public and
   credential-enabled private GitHub clone/push tests. Confirm that HTTP hooks execute and the real
   token remains absent from every guest-visible surface.
4. If native TLS still stalls, verify that `_start()` still has the required semantics before
   updating the validated versions. Run multiple uncached and cached SNI handshakes, callback-error
   cases, VM restarts, and the full Gondolin suite.
5. Recheck whether Gondolin can instead pre-create the `SecureContext` before constructing
   `TLSSocket`, or use `tls.createServer()` with the custom stream. Prefer an upstream fix over
   retaining the monkey patch.

## Artifacts

`deno task release:runner` creates:

- `dist/openorb-runner-linux-x64` from `x86_64-unknown-linux-gnu`
- `dist/openorb-runner-linux-arm64` from `aarch64-unknown-linux-gnu`
- `dist/openorb-runner.service`
- `dist/SHA256SUMS`

`scripts/runner-artifact-metadata.ts` verifies the ELF architecture, computes SHA-256, and checks
the ELF dynamic string table to reject a glibc symbol requirement newer than 2.27. It copies the
reviewed systemd unit into `dist`, and `SHA256SUMS` covers all three installable files. Rebuilding
an unchanged source/lock graph with Deno 2.9.5 must produce identical bytes and checksums.

The executables embed denort. Smoke-test each on its native architecture in a glibc 2.27+
environment that has neither a `node` nor a `deno` executable. `--version` must report the matching
architecture, Deno 2.9.5, and `standalone: true`. `doctor --gateway <origin>` must install and
verify the pinned guest image, validate the host and gateway, fail actionably when QEMU/KVM is
absent, and reject musl hosts. Perform this release validation manually on native x86-64 and ARM64
hosts when CI capacity is unavailable.

## Source checkout alternative

Operators who prefer repository-based upgrades may run the same runner entry point directly with
Deno 2.9.5. The checkout lives at `/opt/openorb`, its prepared Deno cache lives at
`/var/cache/openorb-runner/deno`, and both remain root-owned and read-only to the service. The base
unit remains unchanged; the operator installs either `openorb-runner-source-x64.conf` or
`openorb-runner-source-arm64.conf` as its `source.conf` drop-in. Each override directly executes
Deno with a frozen, cached graph and the compiled artifact's architecture-specific permission
profile, plus read-only access to the checkout and prepared cache. Source overrides are available
from the checkout and are intentionally not standalone release artifacts. See
[Linux runner installation](runner-installation.md).

## Permission boundary

The compile command bakes in:

- read/write access relative to the canonical runner working directory; QEMU, rather than Deno,
  opens `/dev/kvm` and proves acceleration access;
- read-only access to standard system-library directories so `doctor` can inspect the host glibc
  version without FFI or another subprocess;
- unrestricted network access for approved public web access;
- only `/usr/bin/qemu-system-x86_64,/usr/bin/qemu-img` or
  `/usr/bin/qemu-system-aarch64,/usr/bin/qemu-img` subprocess access (absolute target-host paths
  keep cross-compilation independent of the build host's installed QEMU architecture);
- only `PATH`, `PWD`, and Deno's `NODE_V8_COVERAGE` and `TF_BUILD` runtime toggles as environment
  access;
- host UID/GID, home-directory, hostname, CPU, network-interface, OS release, filesystem-capacity,
  and system-memory inspection;
- no FFI and no `--allow-all`.

The standalone entry evaluates the Node-compatible dependency graph with a temporary null-prototype
`process.env` containing only `PATH` and `PWD`, then restores the original Deno permission-checked
environment before starting the runner. This prevents irrelevant import-time agent, CI, and provider
detection in transitive dependencies from requiring access to host secret variables. Dependency
upgrades fail closed if they introduce an unapproved environment read after module evaluation.

Production systemd sets `WorkingDirectory=/var/lib/openorb-runner`. The executable does not accept
`--data-dir`. Deno permissions only govern the runner process; QEMU is a child outside that sandbox.
OpenOrb therefore exposes no raw QEMU path/argv/device interface and creates VMs only through
trusted typed options passed to the pinned Gondolin `VM` API. The systemd sandbox makes the host
filesystem read-only except for runner state, removes capabilities, and grants only explicit
`/dev/kvm` device access. See [Linux runner installation](runner-installation.md).

Unrestricted Deno network permission is not the SSRF boundary. A session may make public HTTP and
HTTPS requests so setup hooks, package managers, and agent tools can query the web. Gondolin
resolves and pins the upstream address and reapplies request and IP policy to every redirect: host
loopback, private, link-local, cloud-metadata, and DNS-rebinding destinations remain blocked.
Guest-local loopback remains available for development servers. Generic TCP and WebSockets remain
disabled. GitHub placeholder substitution is independently restricted to `github.com` and
`api.github.com`; repository authorization follows the GitHub token's own permissions. The Git
credential helper remains scoped to the configured repository for normal clone, fetch, and push.

## Guest assets

VM images are never embedded in the executable. The runner downloads OO-009's architecture-specific
pinned asset into its working directory, verifies it, and gives Gondolin explicit local asset paths.
See [Guest image release process](guest-image.md) for the build, publication, installation, and
recovery procedure.

Do not sign a runner release until native QEMU/KVM integration has exercised the exact executable
and image assets. Release/checksum signing belongs to the release ticket once signing identity and
format are approved.
