# OO-009 — Minimal versioned developer image

**Slice:** 2 — Prove the security boundary  
**Depends on:** OO-008

## Outcome

OpenOrb can boot a pinned, reproducible Gondolin image containing only the tools required by the lean MVP's real path.

## Scope

- Add Gondolin image build configuration compatible with the current macOS harness and future supported Linux runners.
- Include the commands required now: Bash/coreutils, Git, GitHub CLI, CA certificates, and utilities used by setup and controlled reports.
- Add guest language/package tooling only if required by the chosen real acceptance repository; ask before expanding the image. Such guest tooling does not add a Node.js requirement to the Deno runner host.
- Pin the Gondolin package and one exact image build ID with architecture-specific asset URLs, sizes, and SHA-256 hashes in runner release metadata. Never use `latest` in production.
- Distribute QEMU-consumed assets separately from the standalone runner executable. Download atomically into `images/<build-id>/`, verify every asset before use, and pass only verified real filesystem paths to Gondolin.
- Make missing, tampered, incompatible, and download/build failures actionable.

## Acceptance criteria

- A clean image boots through the harness and reports expected pinned identity.
- `bash`, `git`, and `gh` run inside the guest.
- Image configuration and release metadata are reproducible and committed; tampered assets are rejected before Gondolin/QEMU use.
- No package cache, service supervisor, SSH daemon, terminal, preview, or speculative language toolchain is added without a demonstrated current need.
- Runner startup detects an unavailable/incompatible image before provisioning.

## Tests

- Image build/manifest and trusted-hash validation.
- Atomic download/install and tamper rejection.
- Real VM command smoke test through the pinned Gondolin `VM` API.
- Missing/wrong image compatibility failure.

## Not included

Shared caches, checkpoints, managed services, SSH transport, or a broad batteries-included toolchain not needed by the first repository.
