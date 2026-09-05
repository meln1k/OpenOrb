create table workspaces (
  id uuid primary key,
  created_at text not null
);

create table users (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  is_administrator boolean not null default false,
  created_at text not null,
  unique (workspace_id, id)
);

create unique index users_single_administrator_idx
  on users (is_administrator)
  where is_administrator;

create table password_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  salt text not null,
  derived_key text not null,
  algorithm text not null check (algorithm = 'PBKDF2'),
  hash text not null check (hash = 'SHA-256'),
  iterations integer not null check (iterations = 600000),
  key_length_bits integer not null check (key_length_bits = 256),
  created_at text not null
);

create table browser_sessions (
  id text primary key,
  workspace_id uuid,
  user_id uuid,
  data jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint browser_sessions_identity_fk foreign key (workspace_id, user_id)
    references users(workspace_id, id) match full on delete cascade
);

create index browser_sessions_expires_at_idx on browser_sessions (expires_at);
create index browser_sessions_identity_idx on browser_sessions (workspace_id, user_id);
