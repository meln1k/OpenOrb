# Guest image release process

OO-009 defines one OpenOrb guest-image release with immutable Gondolin assets for each supported
runner architecture. The runner uses the published Debian-based `mvp-5` release. An OpenOrb release
ID is not derived from the Gondolin package version or either architecture-specific Gondolin build
ID.

The guest userspace is Debian 13 and provides an Amp-orb-like development command line: Git and
GitHub CLI; GCC/G++, Make, Autoconf, Automake, and pkg-config; Python/pip; Node.js/npm, Corepack,
pnpm, Yarn, and Bun; Perl; FFmpeg and ImageMagick; Vim, tmux, and fzf; archive, network, SSH-client,
and text-processing utilities; plus agent-browser 0.35.0. Versions supplied by Debian come from one
immutable snapshot. Standalone tools and npm packages are versioned and verified by SHA-256. The
image intentionally excludes Amp/E2B internals, Deno, Go, Rust, Java, database CLIs, container and
VM tooling, GUI desktop components, systemd, the SSH daemon, and other services.
`/etc/openorb-image-release` contains the OpenOrb release ID.

The image contains the native agent-browser CLI and browser runtime libraries, but no Chromium or
Chrome executable. OpenOrb's `/usr/local/bin/agent-browser` wrapper downloads a browser before the
first browser-requiring command. On x86-64 it uses `curl` to download the current Stable Chrome for
Testing into `$HOME/.agent-browser/browsers`. The wrapper cannot use native `agent-browser install`
because that command's bundled WebPKI roots do not trust Gondolin's per-VM HTTPS interception CA.
Google does not publish Chrome for Testing for Linux ARM64, so ARM64 instead installs the
snapshot-pinned Debian Chromium 151.0.7922.71 package. The wrapper serializes concurrent first
starts and passes Gondolin's CA to the launched browser. It leaves version, help, close, and
explicit custom-executable calls download-free. Downloaded browser files live in the VM's writable
copy-on-write rootfs and disappear when that rootfs is discarded.

Gondolin 0.12.0 implements only its Alpine build pipeline, so `distro` remains `alpine` in the
Gondolin configurations. The visible root filesystem comes from the OpenOrb Debian OCI image; Alpine
3.23 supplies only the kernel, matching modules, and early initramfs that switches into that Debian
root. Gondolin then runs its own minimal `/init`, not Debian systemd.

## Build

The Debian rootfs source is `images/guest/debian-rootfs.Containerfile`. Its architecture-specific
official Debian base, agent-browser, Bun, websocat, and npm package inputs are pinned in
`scripts/build-guest-image.ts`, and its APT sources use the Debian snapshot from `20260803T000000Z`.
The ARM64 fallback Chromium version is pinned to that same snapshot. The Gondolin configurations are
`images/guest/x86_64.json` and `images/guest/aarch64.json`; each allocates a 2.5 GiB writable rootfs
so the expanded development environment and an on-demand browser fit together. Gondolin is pinned in
`deno.lock` and the Deno import maps.

The repository orb setup installs Podman and the host image-building prerequisites (`cpio`,
`e2fsprogs`, `lz4`, `tar`, and rootless-user-namespace support). Build and smoke-test each asset on
a native Linux host matching the target architecture with Deno 2.9.5:

```sh
deno task build:image x86_64
deno task build:image aarch64
```

`build:image` first builds a local, architecture-specific Debian OCI image with Podman, then asks
Gondolin to export it into the VM rootfs and create the boot assets. It is a trusted release task:
the OCI and Gondolin builders require broad read, write, environment, network, and subprocess
access. Do not run an unreviewed Containerfile or build configuration with these permissions.

Each invocation writes unpacked assets under `dist/guest-image/mvp-5/<gondolin-arch>/`, a
deterministically ordered archive under `dist/guest-image/`, and a neighboring `.json` metadata
file. The final stdout line is the same metadata in compact JSON. It contains the OpenOrb release
ID, architecture-specific Gondolin build ID, normalized manifest SHA-256, archive filename, exact
byte count, and archive SHA-256.

## Version and metadata update

For any guest-content change:

1. Choose a new immutable OpenOrb release ID. Update `scripts/build-guest-image.ts`,
   `images/guest/openorb-image-release`, the native smoke-test expectation, and this document.
2. Change the Containerfile and both architecture configurations together. If the Debian base or
   package snapshot changes, update the pinned inputs explicitly. Build both archives.
3. Run the normal repository checks and the real Gondolin smoke test on each native architecture:

   ```sh
   deno task check
   deno task test
   deno task test:gondolin
   ```

   The smoke test verifies Debian identity, the release marker, manifest identity, `apt`, required
   development commands, `git`, `gh`, noninteractive unauthenticated `gh auth status`, and the
   absence of APT caches, services, host infrastructure, and excluded toolchains. It verifies that
   version and help calls do not install a browser, then launches a browser through agent-browser,
   checks the architecture-specific lazy installation, evaluates JavaScript, reads the resulting DOM
   text, and writes a PNG screenshot. Validate both x86-64 and ARM64 on their native release hosts
   before signing a runner release.
4. Compare each generated `.json` file with
   `packages/runner/src/environment/gondolin/guest-image/release.ts`. Keep the currently published
   release active while the candidate is under test.

After review and **separate explicit approval to publish**, create GitHub release tag
`guest-image-<release-id>` in `meln1k/openorb` and upload exactly the two generated `.tar.gz` files.
Do not upload the unpacked directories or substitute rebuilt archives. After the immutable assets
exist, update `packages/runner/src/environment/gondolin/guest-image/release.ts` with their release
ID, URLs, architecture-specific build IDs, manifest hashes, exact byte counts, and archive hashes.
Never use a moving tag or `latest` URL. Publishing a release or assets is an external write and must
never be part of an ordinary build or test run.

The historical `mvp-2` release retains its legacy `developer-image` tag and
`gondolin-image-openorb-developer-*` filenames. Those immutable compatibility strings must not be
renamed or reused.

## Runner installation and recovery

At startup and during `doctor`, the runner selects the asset matching its host and installs it
under:

```text
<runner-working-directory>/images/<release-id>/<x64|arm64>/
```

The runner requires a successful HTTPS response and checks the exact downloaded byte count and
SHA-256 before extraction. Extraction uses an exact file allowlist and rejects absolute/traversal
paths, links, devices, directories, duplicates, oversized contents, and unexpected files. It then
checks the normalized manifest against its release-pinned SHA-256 before trusting its architecture,
build ID, or asset checksums, then verifies every asset checksum. Only after all checks pass does an
atomic rename expose the final directory. Downloads and temporary directories are removed after
success or failure. The runner repeats manifest and asset verification immediately before each VM
start, and `VM.create` receives the resulting explicit paths, so Gondolin's mutable default-image
lookup is not used.

A pre-existing image is verified rather than silently replaced. If startup reports a corrupt or
incompatible image, stop the runner, remove only the named `images/<release-id>/<architecture>/`
directory, and restart. The runner downloads a fresh verified copy. Never edit files inside an
installed image directory.
