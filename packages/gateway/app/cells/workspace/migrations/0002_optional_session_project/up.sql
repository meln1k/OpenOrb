-- A Session may have no project (ADR 0007): it then has no checkout and no Git integration.
-- SQLite cannot relax NOT NULL in place, so the catalog table is rebuilt with its rows, indexes,
-- and trigger. The composite foreign key is not enforced while projectId is NULL.
CREATE TABLE sessions_0002 (
  workspaceId TEXT NOT NULL,
  id TEXT NOT NULL,
  projectId TEXT,
  createdAt TEXT NOT NULL,
  initialPromptPreview TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, projectId) REFERENCES projects(workspaceId, id) ON DELETE RESTRICT
);
INSERT INTO sessions_0002 (workspaceId, id, projectId, createdAt, initialPromptPreview)
  SELECT workspaceId, id, projectId, createdAt, initialPromptPreview FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_0002 RENAME TO sessions;
CREATE INDEX session_navigation ON sessions(workspaceId, createdAt DESC);
CREATE INDEX project_sessions ON sessions(workspaceId, projectId);
CREATE TRIGGER prevent_session_resurrection BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE workspaceId = NEW.workspaceId AND sessionId = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Session was deleted'); END;
