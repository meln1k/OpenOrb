# OO-009 — Minimal versioned developer image

**Slice:** 2 — Prove the security boundary  
**Depends on:** OO-008

## Outcome

OpenOrb can boot a pinned, reproducible Gondolin image containing only the tools required by the lean MVP's real path.

## Scope

- Add Gondolin image build configuration compatible with the current macOS harness and future supported Linux runners.
- Include the commands required now: Bash/coreutils, Git, GitHub CLI, CA certificates, and utilities used by setup and controlled reports.
- Add Node/package tooling only if required by the chosen real acceptance repository; ask before expanding the image.
- Pin the Gondolin package/image identifiers and record compatibility metadata.
- Make image acquisition/build failure actionable.

## Acceptance criteria

- A clean image boots through the harness and reports expected pinned identity.
- `bash`, `git`, and `gh` run inside the guest.
- Image configuration is reproducible and committed.
- No package cache, service supervisor, SSH daemon, terminal, preview, or speculative language toolchain is added without a demonstrated current need.
- Runner startup detects an unavailable/incompatible image before provisioning.

## Tests

- Image build/manifest validation.
- Real VM command smoke test.
- Missing/wrong image compatibility failure.

## Not included

Shared caches, checkpoints, managed services, SSH transport, or a broad batteries-included toolchain not needed by the first repository.
