-- Web search provider keys reuse the provider-api-key secret purpose; the provider ID lives here.
CREATE TABLE IF NOT EXISTS search_provider_credentials (
  workspaceId TEXT NOT NULL,
  providerId TEXT NOT NULL CHECK (providerId IN ('exa', 'brave', 'tavily')),
  secretKey TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, providerId),
  UNIQUE (workspaceId, secretKey),
  FOREIGN KEY (workspaceId, secretKey) REFERENCES encrypted_secrets(workspaceId, key) ON DELETE CASCADE
);
