# Runner release process

OO-001A establishes the standalone runner build path. OO-009 supplies the first real guest-image
build metadata and OO-023 will complete supported-host/service validation.

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
- `dist/SHA256SUMS`

`scripts/runner-artifact-metadata.ts` verifies the ELF architecture, computes SHA-256, and checks
the ELF dynamic string table to reject a glibc symbol requirement newer than 2.27. Rebuilding an
unchanged source/lock graph with Deno 2.9.5 must produce identical bytes and checksums.

The executables embed denort. Smoke-test each on its native architecture in a glibc 2.27+
environment that has neither a `node` nor a `deno` executable. `--version` must report the matching
architecture, Deno 2.9.5, and `standalone: true`. `doctor` must install and verify the pinned guest
image, fail actionably when QEMU/KVM is absent, and reject musl hosts. CI automation is
intentionally deferred for now; perform this release validation manually on native x86-64 and ARM64
hosts before publishing artifacts.

## Permission boundary

The compile command bakes in:

- read/write access relative to the canonical runner working directory;
- unrestricted network access for approved public web access;
- only `qemu-system-x86_64,qemu-img` or `qemu-system-aarch64,qemu-img` subprocess access;
- only `PATH` and `PWD` environment access;
- host UID/GID, home-directory, network-interface, filesystem-capacity, and system-memory
  inspection;
- no FFI and no `--allow-all`.

Production systemd sets `WorkingDirectory=/var/lib/openorb-runner`. The executable does not accept
`--data-dir`. Deno permissions only govern the runner process; QEMU is a child outside that sandbox.
OpenOrb therefore exposes no raw QEMU path/argv/device interface and must create VMs only through
trusted typed options passed to the pinned Gondolin `VM` API. OO-023 adds the OS-level systemd
sandbox.

Unrestricted Deno network permission is not the SSRF boundary. Application/Gondolin policy must deny
loopback, private, link-local, cloud-metadata, redirect, and DNS-rebinding destinations before
approved web tools are enabled.

## Guest assets

VM images are never embedded in the executable. The runner downloads OO-009's architecture-specific
pinned asset into its working directory, verifies it, and gives Gondolin explicit local asset paths.
See [Guest image release process](guest-image.md) for the build, publication, installation, and
recovery procedure.

Do not sign a runner release until native QEMU/KVM integration has exercised the exact executable
and image assets. Release/checksum signing belongs to the release ticket once signing identity and
format are approved.
