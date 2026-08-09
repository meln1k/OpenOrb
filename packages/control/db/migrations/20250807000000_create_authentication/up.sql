create table users (
  id smallint primary key check (id = 1),
  created_at text not null
);

create table password_credentials (
  user_id smallint primary key references users(id) on delete cascade,
  salt text not null,
  derived_key text not null,
  algorithm text not null,
  memory_kib integer not null,
  passes integer not null,
  parallelism integer not null,
  key_length integer not null,
  created_at text not null
);

create table browser_sessions (
  id text primary key,
  data jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index browser_sessions_expires_at_idx on browser_sessions (expires_at);
