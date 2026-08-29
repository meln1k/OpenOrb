# OO-009 — Minimal versioned guest image

**Slice:** 2 — Prove the security boundary  
**Depends on:** OO-008

## Outcome

OpenOrb can boot a pinned, reproducible Gondolin image with a practical development CLI comparable to a fresh Amp orb.

## Scope

- Add Gondolin image build configuration compatible with the current Linux orb harness and the supported Linux x86-64 and ARM64 runners.
- Include Bash/coreutils, Git/GitHub CLI, compiler and build tooling, Python and Node/Bun package tooling, editors, archive tools, network diagnostics, media utilities used in a fresh Amp development orb, and utilities used by setup and controlled Git Snapshot generation.
- Include the native agent-browser CLI and browser runtime libraries, but provision Chrome or Chromium on first browser use instead of embedding it in the immutable image.
- Pin the Gondolin package and one exact image build ID with architecture-specific asset URLs, sizes, and SHA-256 hashes in runner release metadata. Never use `latest` in production.
- Distribute QEMU-consumed assets separately from the standalone runner executable. Download atomically into `images/<build-id>/`, verify every asset before use, and pass only verified real filesystem paths to Gondolin.
- Make missing, tampered, incompatible, and download/build failures actionable.

## Acceptance criteria

- A clean image boots through the harness and reports expected pinned identity.
- The documented development commands, including `bash`, `git`, `gh`, GCC, Python, Node, Bun, and agent-browser, run inside the guest.
- Chrome/Chromium is absent from the built image; agent-browser downloads it on demand and completes a real browser automation flow.
- Image configuration and release metadata are reproducible and committed; tampered assets are rejected before Gondolin/QEMU use.
- No package cache, service supervisor, SSH daemon, terminal, preview, Amp/E2B internal, host infrastructure tool, or unapproved language toolchain is included.
- Runner startup detects an unavailable/incompatible image before provisioning.

## Tests

- Image build/manifest and trusted-hash validation.
- Atomic download/install and tamper rejection.
- Real VM command smoke test through the pinned Gondolin `VM` API.
- Missing/wrong image compatibility failure.

## Not included

Shared caches, checkpoints, managed services, SSH transport, Amp/E2B internals, container/VM/database host tooling, or additional language ecosystems such as Deno, Go, Rust, and Java.
