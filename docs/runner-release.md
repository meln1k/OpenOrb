# Runner release process

OO-001A establishes the standalone runner build path. OO-009 will supply the first real guest-image
build metadata and OO-023 will complete supported-host/service validation.

## Pinned toolchain

Use Deno 2.9.5 exactly with a frozen `deno.lock`. Dependency installation creates a Deno-managed
local `node_modules` tree for control-panel browser-asset compatibility; it is only a
build/development input and is not shipped with the standalone runner:

```sh
deno --version
deno install --frozen
deno task check
deno task test
deno task release:runner
```

No command invokes Node.js, npm, or pnpm. The compile tasks use Deno's managed npm graph and local
links, not experimental bundling and not npm lifecycle scripts.

## Artifacts

`deno task release:runner` creates:

- `dist/openorb-runner-linux-x64` from `x86_64-unknown-linux-gnu`
- `dist/openorb-runner-linux-arm64` from `aarch64-unknown-linux-gnu`
- `dist/SHA256SUMS`

`scripts/runner-artifact-metadata.ts` verifies the ELF architecture, computes SHA-256, and rejects a
glibc symbol requirement newer than 2.27. Rebuilding an unchanged source/lock graph with Deno 2.9.5
must produce identical bytes and checksums.

The executables embed denort. Smoke-test each on its native architecture in a glibc 2.27+
environment that has neither a `node` nor a `deno` executable. `--version` must report the matching
architecture, Deno 2.9.5, and `standalone: true`. `doctor` must fail actionably when QEMU/KVM is
absent and reject musl hosts. CI automation is intentionally deferred for now; perform this release
validation manually on native x86-64 and ARM64 hosts before publishing artifacts.

## Permission boundary

The compile command bakes in:

- read/write access relative to the canonical runner working directory;
- unrestricted network access for approved public web access;
- only `qemu-system-x86_64,qemu-img` or `qemu-system-aarch64,qemu-img` subprocess access;
- only `PATH` and `PWD` environment access;
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

VM images are never embedded in the executable. OO-009 owns their release metadata, acquisition,
integrity verification, and Gondolin integration; none of that is implemented by OO-001A.

Do not publish placeholder image IDs, URLs, or hashes. Do not sign a runner release until native
QEMU/KVM integration has exercised the exact executable and image assets. Release/checksum signing
belongs to the release ticket once signing identity and format are approved.
