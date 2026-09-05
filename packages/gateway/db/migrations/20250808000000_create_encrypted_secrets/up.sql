create table encrypted_secrets (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  key_version integer not null check (key_version >= 1),
  ciphertext text not null,
  created_at text not null,
  updated_at text not null,
  unique (workspace_id, key),
  unique (workspace_id, id)
);
