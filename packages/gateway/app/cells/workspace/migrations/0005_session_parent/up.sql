-- A Child Session records the Session that created it (ADR 0010). Not a foreign key: deleting a
-- parent leaves its children in place. The index serves the per-parent child limit.
ALTER TABLE sessions ADD COLUMN parentSessionId TEXT;
CREATE INDEX child_sessions ON sessions(workspaceId, parentSessionId);
