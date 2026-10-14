# Runner release process

The standalone runner build produces native Linux artifacts tied to immutable guest-image metadata
and validated on supported hosts.

## Pinned toolchain

Use Node.js **26.11.1**, Vite+ **1.1.0**, and the committed `package-lock.json`. Install the npm
workspace graph with `npm ci`; `.npmrc` maps the `@jsr` scope to the JSR npm registry. Source runners
use Node; standalone runners embed it and do not require an installed JavaScript runtime.

```sh
node --version
npm ci
npm run check
npm test
npm run release:runner
```

Root scripts run TypeScript with Node's built-in type stripping. Vitest through Vite+ transforms
test TSX; Rolldown bundles the gateway Worker; tsdown bundles the runner for Node SEA packaging.
Do not substitute a different runtime, lockfile, or unreviewed dependency graph for a release.

### Gondolin TLS compatibility gate

Guest HTTPS egress, including GitHub mediation and on-demand browser downloads, depends on Gondolin
0.12.0 terminating TLS over its custom `GuestTlsStream`. It uses a server `node:tls` `TLSSocket`
with an asynchronous SNI callback. Node resumes the handshake natively; the former Deno-specific
private `_start()` workaround is not installed on Node.

When upgrading Node or Gondolin, run `npm run test:gondolin` on the target versions, including
public and credential-enabled private GitHub clone/push tests. Verify uncached and cached SNI
handshakes, callback failures, VM restarts, and HTTPS requests reaching the mediation hooks. Never
disable certificate validation or broaden the host allowlist to fix a TLS regression. Real tokens
must remain absent from guest environment values, files, transcripts, and logs.

## Artifacts

`npm run release:runner` creates:

- `dist/openorb-runner-linux-x64`
- `dist/openorb-runner-linux-arm64`
- `dist/openorb-runner.service`
- `dist/SHA256SUMS`

The architecture-specific `compile:runner:linux-x64` and `compile:runner:linux-arm64` scripts produce
tsdown/Node SEA executables. `scripts/runner-artifact-metadata.ts` verifies ELF architecture,
computes SHA-256, and rejects glibc symbol requirements newer than **2.28**. It copies the reviewed
systemd unit into `dist`; `SHA256SUMS` covers all three installable files. Record the reviewed
source revision and locked graph with the release checksums. Do not assume SEA builds are
byte-for-byte reproducible without measuring them.

Smoke-test each executable on its native architecture in a glibc 2.28+ environment with no installed
`node` or `deno` executable. `--version` must report the matching architecture, Node 26.11.1, and
`standalone: true`. `doctor --gateway <origin>` must install and verify the pinned guest image,
validate the host and gateway, fail actionably when QEMU is absent, warn and select TCG when KVM is
unavailable, and reject musl hosts. Perform validation manually on native x86-64 and ARM64 hosts
when CI capacity is unavailable.

## Source checkout alternative

The root-owned checkout lives at `/opt/openorb`, with dependencies installed using `npm ci`.
Install Node at `/usr/local/bin/node`, and the architecture-matching source drop-in as
`source.conf` alongside the unchanged base service. The drop-in directly runs the TypeScript
entrypoint using Node's type stripping, without a shell wrapper. The checkout and `node_modules`
remain read-only to the service. Source drop-ins are not standalone release artifacts. See
[Linux runner installation](runner-installation.md).

## Host and guest isolation boundary

Node is not a replacement runtime permission sandbox. Neither source nor SEA executables bake in
the former Deno filesystem, environment, network, or subprocess grants. The supported production
boundary is the reviewed systemd/OS isolation: a dedicated service identity, read-only host
filesystem except runner state, removed capabilities, and explicit optional `/dev/kvm` access.
Do not describe Node's permission model as equivalent to the removed Deno permissions. Running the
entrypoint outside that unit does not reproduce its OS sandbox.

Production systemd sets `WorkingDirectory=/var/lib/openorb-runner`; no `--data-dir` is accepted.
The runner clears unrelated inherited environment variables before dependency evaluation. Keep
provider credentials and host secrets out of the service environment; do not rely on this
environment hygiene as filesystem or process isolation. Identity files remain mode 0600 in a mode
0700 state directory. Persistence retains atomic publication, file/directory fsync, guest sync and
QEMU flushes; migration does not relax Stop durability.

Untrusted work still runs in Gondolin VMs, not in Node subprocesses on the host. OpenOrb exposes
no raw QEMU path/argv/device interface and creates VMs only through trusted typed options to the
pinned Gondolin `VM` API. QEMU opens optional `/dev/kvm`; without it, TCG is used. No host Git
process consumes the guest workspace.

Host network access is not the SSRF boundary. Gondolin resolves and pins upstream addresses and
reapplies HTTP request/IP policy to redirects: host loopback, private, link-local, cloud-metadata,
and DNS-rebinding destinations remain blocked. Guest-local loopback remains available. Generic TCP
and WebSockets remain disabled. GitHub placeholder substitution is independently restricted to
`github.com` and `api.github.com`; repository authorization follows the token's permissions. The Git
credential helper stays scoped to the configured repository. Generic secrets obey their configured
host policies; omitting allowed hosts intentionally permits substitution to any public HTTP(S) host.

## Guest assets

VM images are never embedded in the executable. The runner downloads the architecture-specific
pinned asset into its working directory, verifies it, and gives Gondolin explicit local asset paths.
See [Guest image release process](guest-image.md) for publication, installation, and recovery.

Do not sign a runner release until native QEMU/KVM integration has exercised the exact executable
and image assets. Release/checksum signing requires a separately approved signing identity and
format.
