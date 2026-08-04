# OO-007 — Audited Pi session factory

**Slice:** 2 — Prove the security boundary  
**Depends on:** OO-001

## Outcome

Every OpenOrb Pi session is created through one audited factory that cannot discover workspace or user-global Pi resources.

## Scope

- Implement `OpenOrbPiSessionFactory` using the current Pi SDK.
- Supply an explicit empty `ResourceLoader`, fresh empty extension runtime, trusted OpenOrb system prompt, and `SettingsManager.inMemory(...)`.
- Put Pi session/model metadata in runner-owned locations outside the workspace.
- Add static restrictions that forbid `DefaultResourceLoader`, file-backed `SettingsManager.create(...)`, and direct Pi session construction outside the factory in runner/session code.
- Build a hostile fixture containing workspace/global settings, extensions, packages, prompts, skills, themes, context files, and system-prompt fragments.

## Acceptance criteria

- A session over the hostile fixture returns only trusted OpenOrb resources and system prompt.
- No hostile module is imported or initialized on the host.
- Global Pi configuration/auth files are not read for session configuration.
- Omitting either the resource loader or settings manager is structurally prevented in runner session code.
- The real Pi SDK is used in tests; a fake agent is not accepted for this boundary.

## Tests

- Hostile workspace/global resource fixture with host-execution marker assertions.
- Static import/lint boundary test.
- Trusted system prompt and empty collection assertions.
- In-memory credential/session path assertions.

## Not included

A model request, browser conversation, follow-up, steering, or custom project resources.
