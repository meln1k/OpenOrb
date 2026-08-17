# Developer image release process

OO-009 defines one OpenOrb developer-image release with immutable Gondolin assets for each supported
runner architecture. The current release ID is `mvp-1`; it is not derived from the Gondolin package
version or from either architecture-specific Gondolin build ID.

The guest is Alpine 3.23.0 with only `bash`, `coreutils`, `git`, `github-cli`, `ca-certificates`,
`curl`, `jq`, `ripgrep`, `file`, `tar`, `unzip`, and `zstd` beyond Gondolin's required kernel and
runtime packages. It has no language toolchain, package cache, preview service, SSH daemon, or
terminal service. `/etc/openorb-image-release` contains the OpenOrb release ID.

## Build

The source configurations are `images/developer/x86_64.json` and `images/developer/aarch64.json`.
Gondolin is pinned in `deno.lock` and the Deno import maps. The repository orb setup installs the
host image-building prerequisites (`cpio`, `e2fsprogs`, and `lz4`).

Build both assets from the repository root with Deno 2.9.5:

```sh
deno task build:image x86_64
deno task build:image aarch64
```

`build:image` is a trusted release task. Gondolin's Node-compatible image builder requires broad
read, write, and environment access; the task restricts network destinations and subprocess names.
Do not run an unreviewed build configuration with these permissions.

Each invocation writes unpacked assets under `dist/developer-image/mvp-1/<gondolin-arch>/`, a
deterministically ordered archive under `dist/developer-image/`, and a neighboring `.json` metadata
file. The final stdout line is the same metadata in compact JSON. It contains the OpenOrb release
ID, architecture-specific Gondolin build ID, normalized manifest SHA-256, archive filename, exact
byte count, and archive SHA-256.

## Version and metadata update

For any guest-content change:

1. Choose a new immutable OpenOrb release ID. Update `scripts/build-developer-image.ts`,
   `images/developer/openorb-image-release`, and the output paths encoded in the checked-in release
   metadata.
2. Change both architecture configurations together and build both archives.
3. Compare each generated `.json` file with `packages/runner/src/developer-image-release.ts`. Copy
   the final per-architecture build ID, manifest SHA-256, byte count, and archive SHA-256 exactly.
   Use the future immutable GitHub release URL; never use a moving tag or `latest` URL.
4. Run the normal repository checks and the real Gondolin smoke test on the native architecture:

   ```sh
   deno task check
   deno task test
   deno task test:gondolin
   ```

   The smoke test verifies the release marker, manifest identity, required commands, `git`, `gh`,
   noninteractive unauthenticated `gh auth status`, and the absence of package caches, a service
   supervisor, excluded toolchains, and SSH. Validate both x86-64 and ARM64 on their native release
   hosts before signing a runner release.

The `mvp-1` asset URLs use GitHub release tag `developer-image-mvp-1`. After review and **separate
explicit approval to publish**, create that release in `meln1k/openorb` and upload exactly the two
generated `.tar.gz` files. Do not upload the unpacked directories or substitute rebuilt archives
without updating the checked-in metadata. Publishing a release or assets is an external write and
must never be part of an ordinary build or test run.

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
