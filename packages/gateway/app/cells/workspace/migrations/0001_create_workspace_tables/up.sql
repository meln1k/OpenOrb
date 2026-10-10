
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  isAdministrator INTEGER NOT NULL CHECK (isAdministrator IN (0, 1)),
  createdAt TEXT NOT NULL,
  UNIQUE (workspaceId, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_administrator ON users(isAdministrator) WHERE isAdministrator = 1;
CREATE TABLE IF NOT EXISTS password_credentials (
  userId TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salt BLOB NOT NULL,
  derivedKey BLOB NOT NULL,
  algorithm TEXT NOT NULL,
  hash TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK (iterations > 0),
  keyLengthBits INTEGER NOT NULL CHECK (keyLengthBits > 0)
);
CREATE TABLE IF NOT EXISTS encrypted_secrets (
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('generic-secret', 'git-credential', 'provider-api-key', 'provider-oauth')),
  keyVersion INTEGER NOT NULL CHECK (keyVersion > 0),
  ciphertext BLOB NOT NULL,
  allowedHosts TEXT CHECK (allowedHosts IS NULL OR json_valid(allowedHosts)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, key)
);
CREATE INDEX IF NOT EXISTS generic_secrets ON encrypted_secrets(workspaceId, key) WHERE purpose = 'generic-secret';
CREATE TABLE IF NOT EXISTS model_provider_credentials (
  id TEXT NOT NULL UNIQUE,
  workspaceId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  credentialType TEXT NOT NULL CHECK (credentialType IN ('api_key', 'oauth')),
  secretKey TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, providerId),
  UNIQUE (workspaceId, secretKey),
  FOREIGN KEY (workspaceId, secretKey) REFERENCES encrypted_secrets(workspaceId, key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS git_author_configuration (
  userId TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  authorName TEXT NOT NULL,
  authorEmail TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS git_credentials (
  id TEXT NOT NULL UNIQUE,
  workspaceId TEXT NOT NULL,
  host TEXT NOT NULL CHECK (host = 'github.com'),
  secretKey TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, host),
  UNIQUE (workspaceId, secretKey),
  FOREIGN KEY (workspaceId, secretKey) REFERENCES encrypted_secrets(workspaceId, key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS projects (
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  repositoryUrl TEXT NOT NULL,
  defaultRef TEXT NOT NULL,
  defaultBranchPattern TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, name)
);
CREATE TABLE IF NOT EXISTS runner_enrollment_tokens (
  workspaceId TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runners (
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  architecture TEXT NOT NULL CHECK (architecture IN ('x64', 'arm64')),
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  revokedAt TEXT,
  PRIMARY KEY (workspaceId, id)
);
CREATE INDEX IF NOT EXISTS runner_listing ON runners(workspaceId, createdAt DESC);
CREATE TABLE IF NOT EXISTS sessions (
  workspaceId TEXT NOT NULL,
  id TEXT NOT NULL,
  projectId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  initialPromptPreview TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, projectId) REFERENCES projects(workspaceId, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS session_navigation ON sessions(workspaceId, createdAt DESC);
CREATE INDEX IF NOT EXISTS project_sessions ON sessions(workspaceId, projectId);
CREATE TABLE IF NOT EXISTS deleted_sessions (
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sessionId TEXT NOT NULL,
  deletedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, sessionId)
);
CREATE TRIGGER IF NOT EXISTS prevent_session_resurrection BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM deleted_sessions WHERE workspaceId = NEW.workspaceId AND sessionId = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Session was deleted'); END;
CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  userId TEXT,
  workspaceId TEXT,
  expiresAt INTEGER NOT NULL,
  CHECK ((userId IS NULL) = (workspaceId IS NULL)),
  FOREIGN KEY (workspaceId, userId) REFERENCES users(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS browser_session_expiry ON browser_sessions(expiresAt);
CREATE TABLE IF NOT EXISTS provider_authorizations (
  workspaceId TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'error')),
  login TEXT CHECK (login IS NULL OR json_valid(login)),
  CHECK ((status = 'pending') = (login IS NOT NULL))
);
