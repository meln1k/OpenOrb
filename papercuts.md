# Papercuts

- 2026-08-26: Session GitHub mediation accidentally denied all non-GitHub public HTTP/HTTPS traffic.
  Repository `.agents/setup` hooks therefore could clone successfully but could not run package
  installation; Debian Snapshot requests resolved to Gondolin's synthetic deny address (`192.0.2.1`)
  and APT surfaced a misleading unsigned-repository error.
- 2026-08-26: The real GitHub mediation integration test requested 4 GiB of guest RAM and failed to
  start under a memory-constrained development orb (`Cannot allocate memory`), even though this test
  path does not require the production session memory profile.
