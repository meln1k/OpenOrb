create table git_author_configuration (
  id smallint primary key check (id = 1),
  author_name text not null check (
    length(btrim(author_name)) between 1 and 200
  ),
  author_email text not null check (
    length(btrim(author_email)) between 3 and 254
  ),
  updated_at text not null
);

create table git_credentials (
  id uuid primary key,
  host text not null unique check (host = 'github.com'),
  encrypted_secret_id uuid not null unique
    references encrypted_secrets(id) on delete restrict,
  created_at text not null,
  updated_at text not null
);

create table projects (
  id uuid primary key,
  name text not null unique check (
    length(btrim(name)) between 1 and 100
  ),
  repository_url text not null check (
    repository_url like 'https://github.com/%.git'
  ),
  default_ref text not null check (
    length(btrim(default_ref)) between 1 and 255
  ),
  default_branch_pattern text not null check (
    length(btrim(default_branch_pattern)) between 1 and 128
  ),
  created_at text not null,
  updated_at text not null
);
