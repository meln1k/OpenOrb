# Snapshot transcript media into private Session storage

**Status:** Accepted

Agents publish images and videos explicitly from `/workspace/.openorb/artifacts`; the runner copies
validated bytes into immutable, bounded, Session-owned storage and the authenticated gateway serves
them with byte-range support. This keeps previews available after Stop without exposing arbitrary
guest paths or allowing remote Markdown images to issue browser tracking requests. A live guest-file
proxy was rejected because it would make transcript history mutable and unavailable whenever the
Agent Environment is stopped.

The runner makes an artifact durable by file-syncing its content, syncing the artifact directory,
file-syncing metadata under a temporary name, atomically renaming that metadata to `<id>.json`, and
syncing the directory again. Final metadata is the commit marker. Before quota accounting, the
runner removes temporary metadata and content without a corresponding commit marker, so an
interrupted publication cannot poison future publication or retain bytes outside the quota model.
